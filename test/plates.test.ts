import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { fetchCabinetTasks, fetchFleetHealth } from "../plates.js";

async function serve(
  t: any,
  port: number,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const srv = http.createServer(handler);
  await new Promise<void>((ok) => srv.listen(port, "127.0.0.1", ok));
  t.after(() => srv.close());
  return srv;
}

test("cabinet plate parses tasks", async (t) => {
  await serve(t, 18992, (_req, res) => {
    res.end(
      JSON.stringify([
        { id: 5243, title: "rotation", assigned_to: "darlene", priority: 1, state: "active", claimed_by: "", created_at: 1, due_at: null, fail_count: 0 },
      ]),
    );
  });
  const p = await fetchCabinetTasks("http://127.0.0.1:18992", 1000);
  assert.equal(p.ok, true);
  assert.equal((p as any).kind, "needs_you");
  assert.equal((p as any).tasks.length, 1);
  assert.equal((p as any).tasks[0].id, 5243);
});

test("cabinet plate hits /api/tasks?state=active", async (t) => {
  let url = "";
  await serve(t, 18996, (req, res) => {
    url = req.url ?? "";
    res.end(JSON.stringify([]));
  });
  const p = await fetchCabinetTasks("http://127.0.0.1:18996", 1000);
  assert.equal(p.ok, true);
  assert.equal(url, "/api/tasks?state=active");
});

test("fleet-health plate parses aggregate", async (t) => {
  await serve(t, 18993, (_req, res) => {
    res.end(JSON.stringify({ healthy: 14, total: 15, threshold: 14, status: "ok" }));
  });
  const p = await fetchFleetHealth("http://127.0.0.1:18993", 1000);
  assert.equal((p as any).kind, "fleet_health");
  assert.equal((p as any).ok, true);
  assert.equal((p as any).status, "ok");
  assert.equal((p as any).healthy, 14);
  assert.equal((p as any).total, 15);
});

test("plates degrade on unreachable backend, never throw", async () => {
  const p = await fetchFleetHealth("http://127.0.0.1:1", 300);
  assert.equal(p.ok, false);
  assert.equal(typeof (p as any).error, "string");
  const q = await fetchCabinetTasks("http://127.0.0.1:1", 300);
  assert.equal(q.ok, false);
  assert.equal((q as any).kind, "needs_you");
});

test("plates abort via AbortController when server accepts but never responds", async (t) => {
  // Accepts connections but never writes a response -> exercises the abort
  // path, not connection-refused (mirrors test/fleet.test.ts pattern).
  const srv = net.createServer(() => {});
  await new Promise<void>((ok) => srv.listen(18994, "127.0.0.1", () => ok()));
  t.after(() => srv.close());
  const started = Date.now();
  const p = await fetchCabinetTasks("http://127.0.0.1:18994", 300);
  const elapsed = Date.now() - started;
  assert.equal(p.ok, false);
  assert.equal(typeof (p as any).error, "string");
  assert.ok(elapsed >= 250, `expected abort at ~300ms, resolved after ${elapsed}ms`);
  assert.ok(elapsed < 5000, `abort must not fall back to the 5s default, took ${elapsed}ms`);
});

test("plates degrade on non-JSON response", async (t) => {
  await serve(t, 18997, (_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html>boom</html>");
  });
  const p = await fetchFleetHealth("http://127.0.0.1:18997", 1000);
  assert.equal(p.ok, false);
  assert.equal(typeof (p as any).error, "string");
});

test("plates degrade on wrong-shape JSON", async (t) => {
  await serve(t, 18998, (_req, res) => {
    res.end(JSON.stringify({ healthy: "many", status: "ok" }));
  });
  await serve(t, 18999, (_req, res) => {
    res.end(JSON.stringify({ tasks: "all of them" }));
  });
  const h = await fetchFleetHealth("http://127.0.0.1:18998", 1000);
  assert.equal(h.ok, false);
  const c = await fetchCabinetTasks("http://127.0.0.1:18999", 1000);
  assert.equal(c.ok, false);
});
