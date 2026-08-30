# Sessions

Starting, finishing, locking and reopening a counting session.

**Shared.**

## What is here

| Path | What it does |
|---|---|
| `auto/` | The automatic session window |
| `history/` | Past sessions and their counts |
| `lock/` | Owner PIN, and the guard on destructive actions |

## Before you change anything

Do not change the auto-session timing constants - seeded test data depends on them exactly as written.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
