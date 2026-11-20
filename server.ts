import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFleet } from "./fleet.js";
import { Feed } from "./feed.js";
import { fetchCabinetTasks, fetchFleetHealth, type CabinetPlate, type FleetHealthPlate } from "./plates.js";

const PLATE_INTERVAL_MS = 30_000;
const STREAM_BROADCAST_MS = 10_000;
const DEFAULT_PORT = 9100;

export interface ServerOptions {
  port?: number;
  agentsPath?: string;
  hermesPath?: string;
  cabinetUrl?: string;
  fleetHealthUrl?: string;
  uiDir?: string;
  pollIntervalMs?: number;
  plateIntervalMs?: number;
}

export interface Snapshot {
  roster: ReturnType<ReturnType<typeof createFleet>["roster"]["publicRoster"]>;
  health: Record<string, unknown>;
  hermes: Record<string, string>;
  plates: { needs_you: CabinetPlate; fleet_health: FleetHealthPlate };
  feed: ReturnType<Feed["all"]>;
}

export function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const agentsPath = opts.agentsPath ?? process.env.FLEET_BRIDGE_AGENTS;
  const hermesPath = opts.hermesPath ?? process.env.FLEET_BRIDGE_HERMES;
  // Plate backends are env-configured (set CABINET_URL / FLEET_HEALTH_URL in
  // deployment); unset URLs degrade those plates to a "not configured" error.
  const cabinetUrl = opts.cabinetUrl ?? process.env.CABINET_URL ?? "";
  const fleetHealthUrl = opts.fleetHealthUrl ?? process.env.FLEET_HEALTH_URL ?? "";
  const uiDir = opts.uiDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");

  const indexHtml = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const appJsPath = path.join(uiDir, "app.js");
  const appJs = fs.existsSync(appJsPath) ? fs.readFileSync(appJsPath, "utf8") : undefined;

  const feed = new Feed();
  const fleet = createFleet(agentsPath, hermesPath, {
    pollIntervalMs: opts.pollIntervalMs,
  });

  let cabinetPlate: CabinetPlate = { kind: "needs_you", ok: false, error: "not polled yet" };
  let fleetHealthPlate: FleetHealthPlate = { kind: "fleet_health", ok: false, error: "not polled yet" };

  const clients = new Set<http.ServerResponse>();

  function snapshot(): Snapshot {
    return {
      roster: fleet.roster.publicRoster(),
      health: Object.fromEntries(fleet.healthCache()),
      hermes: Object.fromEntries(fleet.hermesStatus()),
      plates: { needs_you: cabinetPlate, fleet_health: fleetHealthPlate },
      feed: feed.all(),
    };
  }

  function sseFrame(s: Snapshot): string {
    return `event: snapshot\ndata: ${JSON.stringify(s)}\n\n`;
  }

  function broadcast() {
    const frame = sseFrame(snapshot());
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  fleet.onTransition((t) => {
    const ok = !("error" in t.to) && t.to.ok;
    feed.add({
      runtime: "openclaw",
      agent: t.name,
      summary: ok ? "health recovered" : "health degraded: " + ("error" in t.to ? t.to.error : ""),
      ms: 0,
      ok,
    });
    broadcast();
  });

  const plateIntervalMs = opts.plateIntervalMs ?? PLATE_INTERVAL_MS;
  let plateTimer: NodeJS.Timeout | undefined;
  let platesRunning = false;

  async function refreshPlates() {
    const [c, h] = await Promise.all([
      cabinetUrl
        ? fetchCabinetTasks(cabinetUrl)
        : Promise.resolve<CabinetPlate>({ kind: "needs_you", ok: false, error: "CABINET_URL not configured" }),
      fleetHealthUrl
        ? fetchFleetHealth(fleetHealthUrl)
        : Promise.resolve<FleetHealthPlate>({ kind: "fleet_health", ok: false, error: "FLEET_HEALTH_URL not configured" }),
    ]);
    cabinetPlate = c;
    fleetHealthPlate = h;
  }

  function schedulePlates() {
    if (!platesRunning) return;
    plateTimer = setTimeout(() => {
      void refreshPlates().finally(schedulePlates);
    }, plateIntervalMs);
    plateTimer.unref();
  }

  fleet.start();
  platesRunning = true;
  void refreshPlates().finally(schedulePlates);

  const broadcastTimer = setInterval(broadcast, STREAM_BROADCAST_MS);
  broadcastTimer.unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // attach error/close handling before the first write — a client that
      // RSTs immediately would otherwise emit an uncaught 'error' event
      clients.add(res);
      res.on("error", () => clients.delete(res));
      res.on("close", () => clients.delete(res));
      res.write(sseFrame(snapshot()));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }
    if (url.pathname === "/ui/app.js" && appJs !== undefined) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(appJs);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const ready = new Promise<void>((ok, fail) => {
    server.on("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", fail);
      ok();
    });
  });

  return {
    server,
    ready,
    stop() {
      fleet.stop();
      platesRunning = false;
      if (plateTimer) clearTimeout(plateTimer);
      plateTimer = undefined;
      clearInterval(broadcastTimer);
      for (const res of clients) res.destroy();
      clients.clear();
      return new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
