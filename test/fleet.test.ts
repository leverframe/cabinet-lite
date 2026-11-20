import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startMockGateway } from "./mock-gateway.js";
import { loadRosters, agentHealth, createFleet } from "../fleet.js";

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
  const srv = await startMockGateway(18991);
  t.after(() => srv.close());
  const h = await agentHealth({ host: "127.0.0.1", port: 18991, timeoutMs: 1000 });
  assert.deepEqual(h, { ok: true, status: "live" });
});

test("agentHealth aborts via AbortController when server accepts but never responds", async (t) => {
  // Accepts connections but never writes a response -> exercises the abort
  // path, not connection-refused.
  const srv = net.createServer(() => {});
  await new Promise<void>((ok) => srv.listen(18992, "127.0.0.1", () => ok()));
  t.after(() => srv.close());
  const started = Date.now();
  await assert.rejects(
    agentHealth({ host: "127.0.0.1", port: 18992, timeoutMs: 300 }),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250, `expected abort at ~300ms, rejected after ${elapsed}ms`);
  assert.ok(elapsed < 5000, `abort must not fall back to the 5s default, took ${elapsed}ms`);
});

test("createFleet seeds cache, fires on up-down transition, hermes stays static", async (t) => {
  const dir = tmpRoster({
    "agents.json": {
      agents: [
        { name: "ada", role: "ops", tier: "worker", port: 18993, host: "127.0.0.1", token: "t" },
      ],
    },
    "hermes.json": {
      agents: [
        { name: "miranda", role: "pm", host: "userve1c", ssh_user: "newell", binary: "hermes" },
      ],
    },
  });
  const srv = await startMockGateway(18993);
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
