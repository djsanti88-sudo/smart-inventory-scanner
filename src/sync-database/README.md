# Sync & Database

Saving counts on the device and pushing them to the cloud, including the offline queue and retry.

**Shared.**

## What is here

| Path | What it does |
|---|---|
| `cloud/` | Firestore read/write and the Firebase Admin SDK |
| `mock/` | The fake backend used in dev and tests |
| `queue/` | Pending items, batching, retry |
| `StoreHydrator.tsx` | Loads saved state back into the app on startup |

## Before you change anything

**If you ever leave Firebase, this is the folder that changes.** The storage identifiers (`sis-scan-v1`, IndexedDB `sis-persist`, object store `kv`) must never change casually - old saved data becomes invisible with no error and nothing to restore from.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
