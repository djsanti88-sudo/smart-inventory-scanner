# Testing

This is the canonical proof map. `docs/COMMANDS.md` owns the full command reference; feature-folder
READMEs and co-located tests own detailed local behavior.

## Primary gates

| Change area | Required proof |
|---|---|
| Any meaningful code change | `npm run proof:all` |
| Counting, replay, retry, correction, ledger | `npm run test:ledger` plus `proof:all` |
| Firestore, tenancy, rules, indexes, cloud sync | `npm run test:firebase` plus `proof:all` |
| Customer-visible workflow | relevant Playwright and human-bot run from `docs/QA_BOTS.md` |
| Release candidate | `npm run qa:revision` plus release-specific gates |

`proof:local` and `proof:full` are useful development loops but do not replace `proof:all`. A rule
test that skips because no emulator is running is not Firebase proof.

## Test layers

- **Vitest unit:** deterministic business logic, guards, stores, components, and server helpers.
- **Vitest DOM:** rendered components and browser-dependent state behavior.
- **Node suites:** scripts, import boundaries, artifact consistency, and proof infrastructure.
- **Firebase emulator:** authenticated tenant isolation, roles, sync, transactions, rules, and indexes.
- **Playwright:** real customer interaction through visible controls, refresh, persistence, failures,
  retries, navigation, and roles.
- **Corpus gates:** deterministic truth, generated-artifact integrity, drift, and known poison cases.

Tests live beside the workflow they protect. Important owners include `src/inventory/` for ledger and
replay, `src/decoding/` for decode, `src/sync-database/cloud/` for Firebase, `src/stores/` for
integration ordering, and `e2e/` for browser proof.

## Evidence rules

- Label evidence as unit, integration, mock, emulator, Preview, production, manual, or untested.
- A green test proves only the path it actually exercises. Do not mock away the behavior being claimed.
- Every physical scan must appear and count once; retries must not create another physical event.
- Verify customer-visible results in the rendered UI for critical workflows.
- Never call paid providers from automated tests. Live and production checks require explicit owner
  approval and separate reporting.
- Preserve failures as regression tests or stronger deterministic guards.

## Before handoff

1. Run focused tests while developing.
2. Run every required area-specific gate above.
3. Run `npm run proof:all` after the final simplification.
4. Inspect relevant browser artifacts when the behavior is visual.
5. Report skipped, blocked, and unrun lanes explicitly.

Historical test inventories and counts are available through Git. Do not keep exact test totals here;
they drift whenever the suite changes.

