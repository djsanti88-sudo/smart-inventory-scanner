# Reports & Export

Getting data back out: CSV exports, the variance and boss reports, and shareable report links.

**Shared + Backend.**

## What is here

| Path | What it does |
|---|---|
| `export/` | CSV and other formats, with prices masked by role |
| `variance/` | The reports themselves |

## Before you change anything

Export masks prices and costs by role. If you touch the export path, check the masking tests - a leak here shows one customer another shop's numbers.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
