import fs from "node:fs";

export interface AgentEntry {
  name: string;
  role: string;
  tier?: string;
  model?: string;
  port: number;
  host: string;
  /** gateway token — optional for generic entries (may be unauthenticated) */
  token?: string;
  /** runtime label shown in UI/feed; defaults to "openclaw" */
  runtime?: string;
  /** HTTP probe path; defaults to "/health" */
  healthPath?: string;
}

export interface HermesEntry {
  name: string;
  role: string;
  model?: string;
  host: string;
  ssh_user: string;
  binary: string;
  /** runtime label shown in UI/feed; defaults to "hermes" */
  runtime?: string;
}

/**
 * Single source of truth for the runtime label of a roster entry.
 * Entries without an explicit `runtime` fall back by roster kind:
 * hermes entries -> "hermes", everything else -> "openclaw".
 */
export function runtimeLabel(entry: AgentEntry | HermesEntry): string {
  if (entry.runtime) return entry.runtime;
  return "ssh_user" in entry ? "hermes" : "openclaw";
}

/** Distinct runtime labels across all roster slices, sorted. */
export function distinctRuntimes(roster: {
  openclaw: AgentEntry[];
  hermes: HermesEntry[];
  generic: AgentEntry[];
}): string[] {
  const labels = new Set<string>();
  for (const e of roster.openclaw) labels.add(runtimeLabel(e));
  for (const e of roster.hermes) labels.add(runtimeLabel(e));
  for (const e of roster.generic) labels.add(runtimeLabel(e));
  return [...labels].sort();
}

function loadJson(p: string | undefined): { agents: any[] } {
  if (!p) return { agents: [] };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    const agents = (parsed as { agents?: unknown } | null)?.agents;
    return { agents: Array.isArray(agents) ? (agents as any[]) : [] };
  } catch {
    return { agents: [] };
  }
}

export function loadRosters(agentsPath?: string, hermesPath?: string, genericPath?: string) {
  const openclaw: AgentEntry[] = loadJson(agentsPath).agents;
  const hermes: HermesEntry[] = loadJson(hermesPath).agents;
  const generic: AgentEntry[] = loadJson(genericPath).agents;
  return {
    openclaw,
    hermes,
    generic,
    publicRoster() {
      return {
        openclaw: openclaw.map(({ token: _t, ...rest }) => rest),
        hermes: hermes.map(({ ssh_user: _s, binary: _b, ...rest }) => rest),
        generic: generic.map(({ token: _t, ...rest }) => rest),
      };
    },
    distinctRuntimes() {
      return distinctRuntimes({ openclaw, hermes, generic });
    },
  };
}

export type Health = { ok: boolean; status?: string } | { error: string };

export async function agentHealth(a: {
  host: string;
  port: number;
  healthPath?: string;
  timeoutMs?: number;
}): Promise<Health> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), a.timeoutMs ?? 5000);
  try {
    const r = await fetch(`http://${a.host}:${a.port}${a.healthPath ?? "/health"}`, { signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export type TransitionFn = (entry: {
  name: string;
  runtime: string;
  from: Health;
  to: Health;
  at: number;
}) => void;

const POLL_INTERVAL_MS = 10_000;
const POLL_GAP_MS = 250;
const HEALTH_TIMEOUT_MS = 5_000;

export interface FleetOptions {
  pollIntervalMs?: number;
  /** path to the generic runtime roster (FLEET_BRIDGE_GENERIC in deployment) */
  genericPath?: string;
}

/** HTTP-probeable entries: openclaw roster + generic roster share one code path. */
function probeEntries(roster: ReturnType<typeof loadRosters>): AgentEntry[] {
  return [...roster.openclaw, ...roster.generic];
}

export function createFleet(agentsPath?: string, hermesPath?: string, opts?: FleetOptions) {
  const roster = loadRosters(agentsPath, hermesPath, opts?.genericPath);
  const healths = new Map<string, Health>();
  const transitionFns: TransitionFn[] = [];
  const pollIntervalMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(() => {
      void pollOnce().finally(scheduleNext);
    }, pollIntervalMs);
    timer.unref();
  }

  async function pollOnce() {
    const entries = probeEntries(roster);
    for (let i = 0; i < entries.length; i++) {
      const agent = entries[i];
      if (i > 0) await new Promise((r) => setTimeout(r, POLL_GAP_MS));
      let next: Health;
      try {
        next = await agentHealth({
          host: agent.host,
          port: agent.port,
          healthPath: agent.healthPath,
          timeoutMs: HEALTH_TIMEOUT_MS,
        });
      } catch (err) {
        next = { error: err instanceof Error ? err.message : String(err) };
      }
      const prev = healths.get(agent.name);
      const prevOk = prev !== undefined && !("error" in prev) && prev.ok;
      const nextOk = !("error" in next) && next.ok;
      healths.set(agent.name, next);
      if (prev !== undefined && prevOk !== nextOk) {
        const feed = {
          name: agent.name,
          runtime: runtimeLabel(agent),
          from: prev,
          to: next,
          at: Date.now(),
        };
        for (const fn of transitionFns) {
          try {
            fn(feed);
          } catch (err) {
            console.error(`[fleet] transition subscriber threw for ${agent.name}:`, err);
          }
        }
      }
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
      void pollOnce().finally(scheduleNext);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    hermesStatus(): Map<string, string> {
      return new Map(roster.hermes.map((h) => [h.name, "ssh"]));
    },
  };
}
