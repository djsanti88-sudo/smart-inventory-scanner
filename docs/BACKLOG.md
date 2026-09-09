# Backlog

This file contains only open work that is not already the active phase in `PROGRESS.md`. Current
execution status lives in `PROGRESS.md`; branch and worktree status lives in `REPO_HEALTH.md`.
Completed work belongs in history, not in this list.

## Current open work

- Complete the owner-gated release steps recorded at the top of `PROGRESS.md`, including review,
  push/PR authorization, deployment-environment cleanup, authenticated production smoke, and billing
  reconciliation where applicable.
- Reverify customer-role exposure across API responses, browser persistence, exports, aliases, and
  shared catalog data. Customer clients must not receive or persist the platform barcode/alias corpus.
- Keep `scanStore.ts` decomposition incremental. Extract only independently testable concerns while
  preserving provisional counting before every await and retry idempotency.
- Reassess generated knowledge artifacts and historical snapshots before any repository-size cleanup.
  Verify runtime consumers, hashes, restore paths, and regeneration before deletion.
- Re-run dependency/security triage from the current lockfile before acting on old vulnerability
  counts. Do not use a forced upgrade on load-bearing Firebase or native dependencies without focused
  proof.
- Decide whether the weekly QA/report workflow should be scheduled. Any scheduler, account creation,
  email delivery, or external integration remains owner-gated.

## Unapproved proposals requiring fresh design

- **Idempotency-key scope:** an older design proposed removing `businessId` from generated keys. The
  current implementation still includes it. Do not execute that proposal without re-deriving the
  collision, tenancy, replay, and migration consequences from current code.
- **Further simplification:** continue removing duplication only through bounded, independently
  proven changes. The old campaign brief is not an approved batch refactor.
- **AWS migration:** the August target architecture was design-only. Firebase, Vercel, and Turso
  remain the active stack; any migration needs a new owner-approved design and plan.

## Standing decisions

- Firebase/Firestore remains the active account and tenant backend until an approved migration.
- Platform-owned resolution data stays server-side. Customer roles receive product-facing results,
  not a downloadable internal corpus.
- A correction transfers quantity; it never deletes the physical scan.
- `npm run proof:all` is the primary repository gate. Use the additional ledger, Firebase, and browser
  gates required by the changed area.
- `benchmark-tire-db-automation` is parked and must not be deleted or merged without a new owner
  decision.

## Adding an item

Add only a still-open outcome with an owner, proof requirement, and any external gate. Remove it when
done and record durable decisions or lessons in `DECISIONS.md` or `LESSONS_LEARNED.md`.
