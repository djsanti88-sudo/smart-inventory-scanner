# Shared

Small things genuinely used everywhere.

**Shared.**

## What is here

| Path | What it does |
|---|---|
| `privacy/` | Strips prices, names and emails before anything goes to an outside AI; also the API-key-safety guards |
| `telemetry/` | Logging and the audit trail |
| `text/` | String distance and display formatting |
| `net/` | Fetch with backoff |
| `benchmark/` | Decode benchmark analysis |

## Before you change anything

Keep this folder small and boring. If fewer than three folders import something, it is not shared - it belongs with its owner.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
