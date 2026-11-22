import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { startMockGatewayEphemeral } from "./mock-gateway.js";
import { loadRosters, agentHealth, createFleet, runtimeLabel, distinctRuntimes } from "../fleet.js";

function tmpRoster(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbl-"));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  return dir;
}

test("loadRosters reads agents + hermes and strips secrets on snapshot", () => {
  const dir = tmpRoster({
    "agents.json": {
      agents: [
        { name: "ada", role: "ops", tier: "worker", port: 18803, host: "127.0.0.1", token: "test-token" },
      ],
    },
    "hermes.json": {
      agents: [
        { name: "miranda", role: "pm", host: "userve1c", ssh_user: "newell", binary: "/usr/local/bin/hermes" },
      ],
    },
  });
  const r = loadRosters(path.join(dir, "agents.json"), path.join(dir, "hermes.json"));
  assert.equal(r.openclaw.length, 1);
  assert.equal(r.hermes.length, 1);
  const pub = JSON.stringify(r.publicRoster());
  assert.ok(!pub.includes("test-token"), "token must never appear in public roster");
  assert.ok(!pub.includes("newell"), "ssh_user must never appear in public roster");
  assert.ok(!pub.includes("/usr/local/bin/hermes"), "binary path must never appear in public roster");
});

test("loadRosters returns empty rosters on missing/corrupt files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbl-"));
  const r = loadRosters(path.join(dir, "nope.json"));
  assert.deepEqual(r.openclaw, []);
  assert.deepEqual(r.hermes, []);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.deepEqual(loadRosters(bad).openclaw, []);
  assert.deepEqual(loadRosters().openclaw, []);
});

test("loadRosters degrades to empty when JSON parses but shape is wrong", () => {
  // JSON.parse("null") succeeds — must not throw on .agents access
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbl-"));
  const wrongShape = path.join(dir, "wrong.json");
  fs.writeFileSync(wrongShape, "null");
  assert.deepEqual(loadRosters(wrongShape).openclaw, []);
  assert.deepEqual(loadRosters(wrongShape).hermes, []);
  const noAgents = path.join(dir, "no-agents.json");
  fs.writeFileSync(noAgents, JSON.stringify({ hermes: [] }));
  assert.deepEqual(loadRosters(noAgents).openclaw, []);
  const agentsNotArray = path.join(dir, "agents-not-array.json");
  fs.writeFileSync(agentsNotArray, JSON.stringify({ agents: "nope" }));
  assert.deepEqual(loadRosters(agentsNotArray).openclaw, []);
});

test("agentHealth hits /health and returns json", async (t) => {
  const { srv, port } = await startMockGatewayEphemeral();
  t.after(() => srv.close());
  const h = await agentHealth({ host: "127.0.0.1", port, timeoutMs: 1000 });
  assert.deepEqual(h, { ok: true, status: "live" });
});

test("agentHealth aborts via AbortController when server accepts but never responds", async (t) => {
  // Accepts connections but never writes a response -> exercises the abort
  // path, not connection-refused.
  const srv = net.createServer(() => {});
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const port = (srv.address() as AddressInfo).port;
  t.after(() => srv.close());
  const started = Date.now();
  await assert.rejects(
    agentHealth({ host: "127.0.0.1", port, timeoutMs: 300 }),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250, `expected abort at ~300ms, rejected after ${elapsed}ms`);
  assert.ok(elapsed < 5000, `abort must not fall back to the 5s default, took ${elapsed}ms`);
});

test("createFleet seeds cache, fires on up-down transition, hermes stays static", async (t) => {
  const { srv, port } = await startMockGatewayEphemeral();
  const dir = tmpRoster({
    "agents.json": {
      agents: [
        { name: "ada", role: "ops", tier: "worker", port, host: "127.0.0.1", token: "t" },
      ],
    },
    "hermes.json": {
      agents: [
        { name: "miranda", role: "pm", host: "userve1c", ssh_user: "newell", binary: "hermes" },
      ],
    },
  });
  const fleet = createFleet(path.join(dir, "agents.json"), path.join(dir, "hermes.json"), {
    pollIntervalMs: 300,
  });
  const transitions: any[] = [];
  fleet.onTransition((tr) => transitions.push(tr));
  fleet.start();
  t.after(() => {
    fleet.stop();
    srv.close();
  });

  // first poll seeds with no transition (bounded wait — fail fast if seeding breaks)
  let seeded = false;
  for (let i = 0; i < 40 && !seeded; i++) {
    seeded = fleet.healthCache().has("ada");
    if (!seeded) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(seeded, "fleet failed to seed health cache for ada within 2s");
  assert.deepEqual(fleet.healthCache().get("ada"), { ok: true, status: "live" });
  assert.deepEqual(fleet.hermesStatus(), new Map([["miranda", "ssh"]]));
  assert.equal(transitions.length, 0);

  // gateway dies -> next poll flips ok->error and fires transition
  await new Promise<void>((ok) => srv.close(() => ok()));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].name, "ada");
  assert.ok("error" in transitions[0].to);
  assert.ok("error" in fleet.healthCache().get("ada")!);
});

test("generic roster loads via third path, strips optional token, snapshot key present", () => {
  const dir = tmpRoster({
    "generic.json": {
      agents: [
        { name: "khoj", role: "search", port: 18080, host: "userve1c", runtime: "khoj", healthPath: "/status" },
        { name: "gw", role: "gateway", port: 18999, host: "127.0.0.1", token: "generic-secret" },
      ],
    },
  });
  const r = loadRosters(
    path.join(dir, "agents.json"),
    path.join(dir, "hermes.json"),
    path.join(dir, "generic.json"),
  );
  assert.equal(r.generic.length, 2);
  const pub = r.publicRoster();
  assert.ok(Array.isArray(pub.generic), "snapshot roster must include a generic key");
  assert.equal(pub.generic.length, 2);
  const raw = JSON.stringify(pub);
  assert.ok(!raw.includes("generic-secret"), "generic token must never appear in public roster");
  // two-roster deployments behave byte-identically: generic defaults to empty
  const bare = loadRosters();
  assert.deepEqual(bare.publicRoster().generic, []);
  assert.deepEqual(bare.generic, []);
});

test("generic entry healthPath is used instead of /health", async (t) => {
  const { srv, port } = await startMockGatewayEphemeral();
  t.after(() => srv.close());
  const viaStatus = await agentHealth({ host: "127.0.0.1", port, healthPath: "/status", timeoutMs: 1000 });
  assert.deepEqual(viaStatus, { ok: true, status: "live", via: "status" });
  // default stays /health for openclaw-style entries
  const viaDefault = await agentHealth({ host: "127.0.0.1", port, timeoutMs: 1000 });
  assert.deepEqual(viaDefault, { ok: true, status: "live" });
});

test("createFleet polls generic entries through the same health pipeline", async (t) => {
  const { srv, port } = await startMockGatewayEphemeral();
  const dir = tmpRoster({
    "generic.json": {
      agents: [
        { name: "khoj", role: "search", port, host: "127.0.0.1", runtime: "khoj", healthPath: "/status" },
      ],
    },
  });
  const fleet = createFleet(undefined, undefined, {
    genericPath: path.join(dir, "generic.json"),
    pollIntervalMs: 300,
  });
  const transitions: any[] = [];
  fleet.onTransition((tr) => transitions.push(tr));
  fleet.start();
  t.after(() => {
    fleet.stop();
    srv.close();
  });
  let seeded = false;
  for (let i = 0; i < 40 && !seeded; i++) {
    seeded = fleet.healthCache().has("khoj");
    if (!seeded) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(seeded, "fleet failed to seed health cache for generic entry khoj within 2s");
  assert.deepEqual(fleet.healthCache().get("khoj"), { ok: true, status: "live", via: "status" });

  await new Promise<void>((ok) => srv.close(() => ok()));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].name, "khoj");
  assert.equal(transitions[0].runtime, "khoj", "generic transitions must carry the entry's runtime label");
});

test("runtimeLabel defaults by roster kind and honors explicit override", () => {
  const agent = { name: "ada", role: "ops", host: "h", port: 1, token: "t" };
  assert.equal(runtimeLabel(agent), "openclaw");
  const labeled = { ...agent, runtime: "khoj" };
  assert.equal(runtimeLabel(labeled), "khoj");
  const hermes = { name: "miranda", role: "pm", host: "h", ssh_user: "u", binary: "hermes" };
  assert.equal(runtimeLabel(hermes), "hermes");
  const hermesLabeled = { ...hermes, runtime: "static" };
  assert.equal(runtimeLabel(hermesLabeled), "static");
});

test("distinctRuntimes merges all roster slices into sorted unique labels", () => {
  const labels = distinctRuntimes({
    openclaw: [
      { name: "a", role: "r", host: "h", port: 1, token: "t", runtime: "zed" },
      { name: "b", role: "r", host: "h", port: 2, token: "t" },
    ],
    hermes: [{ name: "c", role: "r", host: "h", ssh_user: "u", binary: "b", runtime: "ada" }],
    generic: [
      { name: "d", role: "r", host: "h", port: 3, runtime: "zed" },
      { name: "e", role: "r", host: "h", port: 4, runtime: "khoj" },
    ],
  });
  assert.deepEqual(labels, ["ada", "khoj", "openclaw", "zed"]);
});
