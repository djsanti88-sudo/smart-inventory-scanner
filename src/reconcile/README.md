# Reconcile

Comparing what you counted against what your shop software says you should have, and reporting the dollar difference.

**Shared.**

## What is here

| Path | What it does |
|---|---|
| `match/` | The matching engine |
| `adapters/` | Shop-Ware and generic file formats |
| `variance/` | The dollar-difference report |

## Before you change anything

This folder was already well organized before the reorganization - it is the shape the other folders were modelled on.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
