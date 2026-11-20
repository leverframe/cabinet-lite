# Configuration

cabinet-lite is configured entirely through two roster files and environment
variables. No config file of its own.

## Rosters

The roster files use the same shape as
[fleet-bridge](https://github.com/leverframe/fleet-bridge)'s `agents.json`
(OpenClaw) and `hermes-agents.json` (Hermes). Both are `{"agents": [...]}`.

### OpenClaw roster (`FLEET_BRIDGE_AGENTS`)

```json
{
  "agents": [
    {
      "name": "clifford",
      "role": "repo janitor",
      "tier": "worker",
      "model": "glm-5.3-flash",
      "port": 18800,
      "host": "userve1c",
      "token": "<gateway token>"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | agent name — key for health lookups and feed entries |
| `role` | yes | one-line role, shown on the lever tile |
| `tier` | no | fleet tier (e.g. `worker`) |
| `model` | no | model the agent runs |
| `port` | yes | gateway port on the host — polled at `http://{host}:{port}/health` |
| `host` | yes | hostname reachable from the box running cabinet-lite |
| `token` | yes | gateway token — used only server-side if invoke lands in v2 |

### Hermes roster (`FLEET_BRIDGE_HERMES`)

```json
{
  "agents": [
    {
      "name": "miranda",
      "role": "PM",
      "model": "gemini-flash",
      "host": "userve1c",
      "ssh_user": "newell",
      "binary": "hermes"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | agent name |
| `role` | yes | one-line role, shown on the lever tile |
| `model` | no | model the agent runs |
| `host` | yes | host the agent lives on |
| `ssh_user` | yes | SSH user for Hermes invocations (v2) |
| `binary` | yes | Hermes binary path/name on the host (v2) |

### Secrets never reach the browser

`token`, `ssh_user`, and `binary` are **stripped from every API response**.
The server builds a public roster projection (`publicRoster()`) before any
snapshot or SSE frame leaves the process — those fields never reach the
browser, and tokens never leave the box.

## Plates

Plates are bolted-in instruments in the sidebar/header. v1 ships two:

| Plate | Backend | Source |
|---|---|---|
| `needs_you` | Cabinet | `GET {CABINET_URL}/api/tasks?state=active` |
| `fleet_health` | fleet-health aggregate | `GET {FLEET_HEALTH_URL}/fleet-health` |

**Degrade behavior:** an unset URL, an unreachable backend, a timeout, or an
unexpected response shape degrades that plate to an error state — the UI
renders a bordered empty slot ("cabinet offline — ..." / "not configured"),
never a crash. The box keeps rendering everything else, and the plate
recovers on the next poll.

## Poll cadences

| What | Cadence |
|---|---|
| Agent health polls (`/health` per OpenClaw agent, 250ms stagger between agents, 5s timeout) | every 10s |
| Plate backends (cabinet + fleet-health) | every 30s |
| SSE snapshot broadcast | every 10s, plus immediately on health transitions |

## Feed semantics

- In-memory **ring buffer, capped at 500 entries**, newest first. Restarts
  the box reset the feed — it is a journal, not a store.
- In v1, feed entries are **health transitions**: an OpenClaw agent flipping
  live↔down adds an entry (`health recovered` / `health degraded: <error>`).
- Every entry carries runtime provenance (`openclaw` / `hermes` / `mcp`),
  a timestamp, latency, and ok/fail — the feed is the same surface v2's
  lever pulls will land in.
