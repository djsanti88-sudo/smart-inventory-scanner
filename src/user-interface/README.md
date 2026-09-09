# User Interface

Cross-app chrome and generic UI only.

**Frontend.**

## What is here

| Path | What it does |
|---|---|
| `shell/` | Nav, and the production-Firebase warning banner |
| `ui/` | Badges, image hover preview |

## Before you change anything

Feature components live WITH their feature (`src/scanning/`, `src/review/`, and so on). Only put something here if it is genuinely used across the whole app.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
