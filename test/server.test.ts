import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startMockGateway } from "./mock-gateway.js";
import { startServer } from "../server.js";

const GW_PORT = 19011;
const CABINET_PORT = 19012;
const HEALTH_PORT = 19013;
const SERVER_PORT = 19010;

interface Fixture {
  rosterDir: string;
  uiDir: string;
  agentsPath: string;
  hermesPath: string;
  cleanup: () => void;
}

function buildFixture(): Fixture {
  const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbl-srv-"));
  fs.writeFileSync(
    path.join(rosterDir, "agents.json"),
    JSON.stringify({
      agents: [
        { name: "ada", role: "ops", tier: "worker", port: GW_PORT, host: "127.0.0.1", token: "secret-openclaw-token" },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(rosterDir, "hermes.json"),
    JSON.stringify({
      agents: [
        { name: "miranda", role: "pm", host: "userve1c", ssh_user: "secret-ssh-user", binary: "/usr/local/bin/hermes" },
      ],
    }),
  );
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbl-ui-"));
  fs.writeFileSync(
    path.join(uiDir, "index.html"),
    "<!doctype html><html><head><title>LEVERFRAME</title></head><body>placeholder</body></html>",
  );
  return {
    rosterDir,
    uiDir,
    agentsPath: path.join(rosterDir, "agents.json"),
    hermesPath: path.join(rosterDir, "hermes.json"),
    cleanup: () => {
      fs.rmSync(rosterDir, { recursive: true, force: true });
      fs.rmSync(uiDir, { recursive: true, force: true });
    },
  };
}

function get(port: number, reqPath: string): Promise<{
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: reqPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
  });
}

test("server serves snapshot, ui, SSE stream, and 404s unknown paths", async (t) => {
  const fx = buildFixture();
  t.after(() => fx.cleanup());

  const gw = await startMockGateway(GW_PORT);
  const cabinet = http.createServer((_req, res) => {
    res.end(
      JSON.stringify([
        { id: 1, title: "rotation", assigned_to: "darlene", priority: 1, state: "active", claimed_by: "", created_at: 1, due_at: null, fail_count: 0 },
      ]),
    );
  });
  await new Promise<void>((ok) => cabinet.listen(CABINET_PORT, "127.0.0.1", () => ok()));
  const fh = http.createServer((_req, res) => {
    res.end(JSON.stringify({ healthy: 18, total: 20, threshold: 18, status: "ok" }));
  });
  await new Promise<void>((ok) => fh.listen(HEALTH_PORT, "127.0.0.1", () => ok()));

  const srv = startServer({
    port: SERVER_PORT,
    agentsPath: fx.agentsPath,
    hermesPath: fx.hermesPath,
    cabinetUrl: `http://127.0.0.1:${CABINET_PORT}`,
    fleetHealthUrl: `http://127.0.0.1:${HEALTH_PORT}`,
    uiDir: fx.uiDir,
    pollIntervalMs: 250,
    plateIntervalMs: 250,
  });
  t.after(() => {
    srv.stop();
    gw.close();
    cabinet.close();
    fh.close();
  });
  await srv.ready;
  let snap: any;
  for (let i = 0; i < 40 && !snap; i++) {
    const res = await get(SERVER_PORT, "/api/snapshot");
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    if (parsed.health.ada && parsed.plates.needs_you.ok && parsed.plates.fleet_health.ok) snap = parsed;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(snap, "snapshot never filled (fleet seed or plate cycle broke within 4s)");
  assert.deepEqual(snap.roster.openclaw, [
    { name: "ada", role: "ops", tier: "worker", port: GW_PORT, host: "127.0.0.1" },
  ]);
  assert.deepEqual(snap.hermes, { miranda: "ssh" });
  assert.equal(snap.plates.needs_you.tasks[0].id, 1);
  assert.equal(snap.plates.fleet_health.healthy, 18);
  assert.ok(Array.isArray(snap.feed));
  const raw = JSON.stringify(snap);
  assert.ok(!raw.includes("secret-openclaw-token"), "token leaked into snapshot");
  assert.ok(!raw.includes("secret-ssh-user"), "ssh_user leaked into snapshot");
  assert.ok(!raw.includes("/usr/local/bin/hermes"), "binary path leaked into snapshot");

  // perf bar: snapshot is cache-read only, must stay well under 50ms
  const perfStart = Date.now();
  const perf = await get(SERVER_PORT, "/api/snapshot");
  const perfMs = Date.now() - perfStart;
  assert.equal(perf.status, 200);
  assert.ok(perfMs < 50, `snapshot took ${perfMs}ms locally, budget is 50ms`);

  // root: placeholder ui
  const root = await get(SERVER_PORT, "/");
  assert.equal(root.status, 200);
  assert.match(root.headers["content-type"] ?? "", /text\/html/);
  assert.ok(root.body.includes("LEVERFRAME"));

  // unknown path
  const missing = await get(SERVER_PORT, "/nope");
  assert.equal(missing.status, 404);

  // SSE stream: first event must be a full snapshot
  const sse = await new Promise<{ headers: http.IncomingHttpHeaders; first: string }>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: SERVER_PORT, path: "/api/stream" }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        if (buf.includes("\n\n")) {
          const first = buf.slice(0, buf.indexOf("\n\n") + 1);
          req.destroy();
          resolve({ headers: res.headers, first });
        }
      });
      res.on("error", () => {});
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET") return; // expected from req.destroy()
      reject(err);
    });
  });
  assert.match(sse.headers["content-type"] ?? "", /text\/event-stream/);
  assert.match(sse.headers["cache-control"] ?? "", /no-cache/);
  assert.ok(sse.first.startsWith("event: snapshot\n"), `first SSE event was not snapshot: ${JSON.stringify(sse.first)}`);
  const dataLine = sse.first.split("\n").find((l) => l.startsWith("data: "));
  assert.ok(dataLine, "snapshot event missing data line");
  const sseSnap = JSON.parse(dataLine!.slice("data: ".length));
  assert.deepEqual(sseSnap, snap);
});
