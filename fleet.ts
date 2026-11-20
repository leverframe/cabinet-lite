import fs from "node:fs";

export interface AgentEntry {
  name: string;
  role: string;
  tier?: string;
  model?: string;
  port: number;
  host: string;
  token: string;
}

export interface HermesEntry {
  name: string;
  role: string;
  model?: string;
  host: string;
  ssh_user: string;
  binary: string;
}

function loadJson(p: string | undefined): { agents: any[] } {
  if (!p) return { agents: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { agents: [] };
  }
}

export function loadRosters(agentsPath?: string, hermesPath?: string) {
  const openclaw: AgentEntry[] = loadJson(agentsPath).agents;
  const hermes: HermesEntry[] = loadJson(hermesPath).agents;
  return {
    openclaw,
    hermes,
    publicRoster() {
      return {
        openclaw: openclaw.map(({ token: _t, ...rest }) => rest),
        hermes: hermes.map(({ ssh_user: _s, binary: _b, ...rest }) => rest),
      };
    },
  };
}

export async function agentHealth(a: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), a.timeoutMs ?? 5000);
  try {
    const r = await fetch(`http://${a.host}:${a.port}/health`, { signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export type Health = { ok: boolean; status?: string } | { error: string };
export type TransitionFn = (entry: {
  name: string;
  from: Health;
  to: Health;
  at: number;
}) => void;

const POLL_INTERVAL_MS = 10_000;
const POLL_GAP_MS = 250;
const HEALTH_TIMEOUT_MS = 5_000;

export interface FleetOptions {
  pollIntervalMs?: number;
}

export function createFleet(agentsPath?: string, hermesPath?: string, opts?: FleetOptions) {
  const roster = loadRosters(agentsPath, hermesPath);
  const healths = new Map<string, Health>();
  const transitionFns: TransitionFn[] = [];
  const pollIntervalMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function pollOnce() {
    for (const agent of roster.openclaw) {
      let next: Health;
      try {
        next = await agentHealth({
          host: agent.host,
          port: agent.port,
          timeoutMs: HEALTH_TIMEOUT_MS,
        });
      } catch (err: any) {
        next = { error: err?.message ?? String(err) };
      }
      const prev = healths.get(agent.name);
      const prevOk = prev !== undefined && !("error" in prev) && prev.ok;
      const nextOk = !("error" in next) && next.ok;
      healths.set(agent.name, next);
      if (prev !== undefined && prevOk !== nextOk) {
        const feed = { name: agent.name, from: prev, to: next, at: Date.now() };
        for (const fn of transitionFns) fn(feed);
      }
      await new Promise((r) => setTimeout(r, POLL_GAP_MS));
    }
  }

  return {
    roster,
    onTransition(fn: TransitionFn) {
      transitionFns.push(fn);
    },
    healthCache(): Map<string, Health> {
      return new Map(healths);
    },
    start() {
      if (running) return;
      running = true;
      void pollOnce();
      timer = setInterval(() => void pollOnce(), pollIntervalMs);
      timer.unref();
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    hermesStatus(): Map<string, string> {
      return new Map(roster.hermes.map((h) => [h.name, "ssh"]));
    },
  };
}
