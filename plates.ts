export type CabinetTask = {
  id: number;
  title: string;
  assigned_to: string;
  priority: number;
  state: string;
  claimed_by: string;
  created_at: number | null;
  due_at: number | null;
  fail_count: number;
};

export type CabinetPlate =
  | { kind: "needs_you"; ok: true; tasks: CabinetTask[] }
  | { kind: "needs_you"; ok: false; error: string };

export type FleetHealthPlate =
  | { kind: "fleet_health"; ok: true; healthy: number; total: number; threshold: number; status: string }
  | { kind: "fleet_health"; ok: false; error: string };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function getJson(base: string, path: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, base), { signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCabinetTasks(base: string, timeoutMs = 5000): Promise<CabinetPlate> {
  try {
    const parsed: unknown = await getJson(base, "/api/tasks?state=active", timeoutMs);
    const body = parsed as { tasks?: unknown } | null;
    const tasks = Array.isArray(parsed) ? parsed : Array.isArray(body?.tasks) ? body.tasks : null;
    if (!tasks) return { kind: "needs_you", ok: false, error: "unexpected /api/tasks shape" };
    return { kind: "needs_you", ok: true, tasks: tasks as CabinetTask[] };
  } catch (err) {
    return { kind: "needs_you", ok: false, error: errMsg(err) };
  }
}

export async function fetchFleetHealth(base: string, timeoutMs = 5000): Promise<FleetHealthPlate> {
  try {
    const parsed: unknown = await getJson(base, "/fleet-health", timeoutMs);
    const body = parsed as { healthy?: unknown; total?: unknown; threshold?: unknown; status?: unknown } | null;
    if (
      typeof body?.healthy !== "number" ||
      typeof body?.total !== "number" ||
      typeof body?.threshold !== "number" ||
      typeof body?.status !== "string"
    ) {
      return { kind: "fleet_health", ok: false, error: "unexpected /fleet-health shape" };
    }
    return {
      kind: "fleet_health",
      ok: true,
      healthy: body.healthy,
      total: body.total,
      threshold: body.threshold,
      status: body.status,
    };
  } catch (err) {
    return { kind: "fleet_health", ok: false, error: errMsg(err) };
  }
}
