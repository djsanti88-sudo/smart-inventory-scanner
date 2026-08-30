# Admin

Things only the platform owner can do: the shared master catalog and its review queue, disputes, prefix rules.

**Backend, with a little UI.**

## What is here

| Path | What it does |
|---|---|
| `CatalogReviewTable.tsx` | The owner review queue |

## Before you change anything

The server half deliberately stays in `src/server/catalog/`, behind the server boundary. KNOWN GAP: platform-owner logic is still embedded inside some customer-facing files (the scan feed, the export, display names). Untangling that is a separate, security-relevant project.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
