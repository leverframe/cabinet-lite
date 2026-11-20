import test from "node:test";
import assert from "node:assert/strict";
import { Feed } from "../feed.js";

test("feed keeps newest 500, newest first", () => {
  const f = new Feed(3);
  f.add({ runtime: "openclaw", agent: "a1", summary: "x", ms: 1, ok: true });
  f.add({ runtime: "hermes", agent: "a2", summary: "y", ms: 2, ok: true });
  f.add({ runtime: "mcp", agent: "a3", summary: "z", ms: 3, ok: false });
  f.add({ runtime: "openclaw", agent: "a4", summary: "w", ms: 4, ok: true });
  const all = f.all();
  assert.equal(all.length, 3);
  assert.equal(all[0].agent, "a4");
  assert.equal(all[0].runtime, "openclaw");
});

test("add stamps ts and all returns a copy", () => {
  const f = new Feed();
  f.add({ runtime: "mcp", agent: "a1", summary: "hello", ms: 5, ok: true });
  const all = f.all();
  assert.equal(all.length, 1);
  assert.equal(typeof all[0].ts, "number");
  all.push({ ts: 0, runtime: "mcp", agent: "ghost", summary: "", ms: 0, ok: false });
  assert.equal(f.all().length, 1);
});
