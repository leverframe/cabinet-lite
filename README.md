<div align="center">

<img src="assets/bite.svg" alt="Leverframe bite mark" width="96" />

# `cabinet-lite`

the leverframe signal box — a cross-runtime fleet dashboard for OpenClaw, Hermes, and MCP

[![CI](https://img.shields.io/github/actions/workflow/status/leverframe/cabinet-lite/ci.yml?branch=main&style=flat-square&label=CI&labelColor=111213&color=FFB000)](https://github.com/leverframe/cabinet-lite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-FFB000?style=flat-square&labelColor=111213)](LICENSE)
![read-only v1](https://img.shields.io/badge/read--only-v1-111213?style=flat-square&labelColor=111213)

</div>

---

cabinet-lite is a read-only cockpit for an agent fleet. It answers four
questions at a glance: **what needs me** (the `needs_you` plate), **who's
free** (live/down/idle lever tiles), **what happened** (the pull feed), and —
in v2 — **act from here** (the invoke panel is wired in the UI but GO-gated
off). Every pull that flows through the box is journaled to the feed with
runtime provenance (OpenClaw / Hermes / MCP). Plates are bolted-in
instruments; v1 ships two: `needs_you` (Cabinet) and `fleet_health`
(fleet-health aggregate).

## Quickstart

Prerequisites:

- Node >= 24
- Two roster files, same shape as [fleet-bridge](https://github.com/leverframe/fleet-bridge)'s
  `agents.json` / `hermes-agents.json` (see [docs/CONFIG.md](docs/CONFIG.md))

| Var | Default | Meaning |
|---|---|---|
| `FLEET_BRIDGE_AGENTS` | (required) | path to OpenClaw roster JSON |
| `FLEET_BRIDGE_HERMES` | (required) | path to Hermes roster JSON |
| `CABINET_URL` | (unset = plate degrades) | Cabinet base URL, read-only |
| `FLEET_HEALTH_URL` | (unset = plate degrades) | fleet-health aggregate URL |
| `PORT` | `9100` | listen port |

```bash
npm ci && npm run build && npm start
```

Open `http://127.0.0.1:9100` — the box listens on loopback only.

## Read-only

**v1 ships no invoke endpoint. Read-only by absence.** There is nothing to
POST to: the server exposes `/`, `/ui/app.js`, `/api/snapshot` (GET), and
`/api/stream` (SSE). The invoke panel in the UI is disabled (`GO-gated — v2`).

The `CABINET_URL` and `FLEET_HEALTH_URL` backends are consumed with plain
HTTP GETs (`/api/tasks?state=active`, `/fleet-health`). The Cabinet
production instance is never written to — cabinet-lite reads it, it does not
touch it.

## Screenshots

<!-- screenshots land in Task 7 -->

## Configuration

Roster schemas, plate degrade behavior, poll cadences, and feed semantics are
documented in [docs/CONFIG.md](docs/CONFIG.md).

## License

[MIT](LICENSE)
