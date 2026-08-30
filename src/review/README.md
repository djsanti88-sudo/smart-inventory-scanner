# Review

The Needs Review queue: approving a guess, correcting a wrong product, and teaching the app an alias.

**Frontend + shared rules.**

## What is here

| Path | What it does |
|---|---|
| `NeedsReviewTable.tsx` | The queue |
| `SuggestedApprovalPanel.tsx` | Approve or edit a suggested identity |
| `reviewDecisionVersion.ts` | Stops a stale decision resurrecting an already-resolved row |

## Before you change anything

These are three DIFFERENT operations and must not be merged: confirming an identity creates an alias, editing metadata changes fields only, and reassigning transfers the count.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
