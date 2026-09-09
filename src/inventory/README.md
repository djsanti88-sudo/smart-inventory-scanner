# Inventory & Counting

The count ledger: the single place where a scan becomes a number.

**Shared (pure logic).**

## What is here

| Path | What it does |
|---|---|
| `ledger.ts` | Applies a scan event exactly once. 95 lines. The most important file in the app |
| `replay.ts` | Rebuilds the counts from the scan feed, to prove they are right |
| `idempotency.ts` | Keys minted at scan time, so a retry never double-counts |
| `FinalCountTable.tsx` | What the customer actually sees |
| `cleanup/` | Removing junk counts, with undo |

## Before you change anything

Run `npm run test:ledger` after ANY change here. `ledger.ts` is small and correct - resist tidying it. Fixing a wrong scan MOVES the count; it never deletes it.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
