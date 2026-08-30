# Decoding

Figuring out an unknown barcode: free lookups first, then ONE paid AI call - plus every spend cap and kill switch that guards it.

**Backend, with a small owner-facing panel.**

## What is here

| Path | What it does |
|---|---|
| `server/pipeline/` | The ladder. Stops at the first usable identity |
| `server/knowledge/` | The tire and retail barcode corpora (400MB+) and their loaders |
| `server/cache/` | Remembers positive answers, so you never pay for the same code twice |
| `limits/` | Daily and account caps, spend guard, circuit breaker, kill switch |
| `panel/` | The owner-facing readout |

## Before you change anything

The corpus loaders build file paths from `process.cwd()` SEGMENTS. TypeScript cannot check those, and a text search will not find them. If one goes stale, every test still passes and production silently falls through to PAID AI - that happened on 2026-07-09. After any move here run `npm run build` and confirm the corpus tests RAN rather than skipped.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
