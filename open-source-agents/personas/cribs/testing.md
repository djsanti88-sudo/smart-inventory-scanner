# Test-Triage Crib: Scanbin (inventory)

Verified against package.json / TESTING.md / docs/COMMANDS.md / docs/QA_BOTS.md, 2026-07-25.
Identify/review/suggest only. Never propose code.

## Suite map (exact script names)
- `npm run test` -> `vitest run` (all projects: `unit` node env for services/eval/server/app/scripts,
  `dom` jsdom for components/stores/camera). Fast, default gate for any logic change.
- `npx vitest run <path>` -> one file; add `-t "name"` for one test.
- `npm run test:ledger` -> 8 pinned crown-invariant files (ledgerInvariants, unknownEnqueue,
  mergeUnion, markWrongTransfer, provenanceTier, goldenClasses, inventory.replay,
  ladderTimeout). MANDATORY for ANY change touching counting/quantity/markWrong/merge/sync ledger.
- `npm run test:golden` -> `vitest run src/eval/goldenBaseline.test.ts`, owner-loved 100/100 offline
  baseline slice, Turso forced off, deterministic.
- `npm run test:corpus-drift` -> corpus payload/manifest drift + 10 golden barcodes, filesystem-only,
  wired into `qa:revision`.
- `npm run test:e2e` -> Playwright mock E2E, `playwright.config.ts`, port 3100, ~33 specs, webServer
  sets `IS_E2E=1` (forces `/api/ai-lookup` mock-only - guarantees E2E never spends money). Proof
  screenshots to `e2e/proof/`.
- `npm run test:e2e:firebase` -> emulator-backed E2E with REAL login UI (no auth bypass), port 3200,
  wraps `firebase emulators:exec`.
- `npm run test:firebase` -> `firebase emulators:exec ... vitest run src/services/db/firebase`
  (tenant isolation via real firestore.rules, audit append-only). Self-skips under plain `npm test`.
- `npm run qa:bots` (+ `:tire` `:security` `:ux` `:manager` `:data` `:performance` `:all`) -> human-bot
  Playwright, port 3300, `playwright.bots.config.ts`, mock backend, screenshots + JSON to
  `reports/human-bots/`.
- `npm run qa:bots:live` -> **LIVE**, real cloud Firebase + real login (GOD_EMAIL/GOD_PASSWORD), AI
  still mocked. Stop other dev servers first. Owner-gated.
- `npm run qa:revision` -> full handoff gate: `tsc --noEmit` + `eslint src e2e` + `next build` +
  `playwright test` (mock) + `test:firebase` + `test:corpus-drift` + `qa:bots`.
- `npm run proof:local` -> `tsc --noEmit && vitest run`. `npm run proof:full` -> proof:local + build.
- `npm run teach:test` -> `node --test "e2e/teach/**/*.test.mjs"` (Batch A harness suite, exists/runs).
  `npm run teach` / `teach:cleanup` currently point at files NOT YET BUILT on some branches - verify
  the target file exists before treating a "command not found" as a regression.
- `npm run teach:regression` -> drives `testing/tests/permanent` against `TEACH_TARGET_URL` (defaults
  to real production, no local webServer) - treat as LIVE/owner-gated like other prod-facing runs.

## Which gate for which change class
- Counting/quantity/ledger/markWrong/merge/sync/idempotency -> `test:ledger` MANDATORY, plus `test`.
- Scanner resolution, inventory, roles/auth, exports, catalog, aliases, product data -> human-bot proof
  REQUIRED before handoff (`docs/QA_BOTS.md`); unit tests alone are NOT sufficient (the leak that
  motivated the gate passed unit tests). Run `qa:bots:tire` for resolution/normalization,
  `qa:bots:security` for roles/auth/exports/catalog/aliases/API/Firebase-rules/localStorage,
  `qa:bots:data` for sync/cache/import/export/counting, `qa:bots:ux` for any UI change.
- Live-account resolution changes -> also `qa:bots:live`.
- Auth/Firestore-touching changes -> also `test:e2e:firebase`.
- Any UI flow change -> Playwright `test:e2e` + relevant `qa:bots:*` + screenshots.
- Corpus/knowledge-base regen -> `test:corpus-drift`.
- Pre-handoff/PR-ready claim of any kind -> `qa:revision` (or named equivalents) is the bar; a report
  claiming "ready" must state per-claim automated/mocked/live/manual/untested.

## Known-flaky registry
- `cloudDrainRace.store.test.ts` (part of the default `test` run): timing-flaky ONLY under full
  parallel vitest load; passes when rerun isolated (`npx vitest run <path>`). A single failure here
  under full-suite load is not proof of a regression - rerun isolated before treating as real.

## PAID / LIVE scripts - must NEVER run casually, owner approval required every time
`npm run benchmark` (400 Firecrawl-credit cap), `npm run live-decode-smoke` (paid when
`LIVE_AI_TEST=1`), `npm run eval-decode -- --live` (paid, capped 10 codes), `npm run intel:now` /
`intel:tire-scan` / `npm run weekly-report` (paid decode + Gmail send), `npm run harvest*` (live
scraping, ToS-sensitive), `npm run test:firebase:cloud-smoke` (live cloud writes, self-cleaning),
`node scripts/create-god-account.mjs` / `repair-god-alias.mjs --repair` (live account provisioning),
`node scripts/gpt-ladder-live-proof.mts` / `fetchv2-*.mts` (paid probes), `npm run deploy:rules:prod`
(live prod Firestore rules deploy), `npm run qa:bots:live` (live cloud + real login),
`npm run teach:regression` (drives real production by default).

## Ports
3000 dev default | 3100 mock Playwright E2E | 3200 Firebase-emulator E2E (also INTEL_PORT default) |
3300 QA human-bots | 3400 Fable5 personas/stress | 8080/9099/4001 Firestore/Auth emulator/emulator UI.

## IS_E2E mock forcing
The Playwright webServer for mock configs sets `IS_E2E=1`, which forces `/api/ai-lookup` to
mock-only regardless of other flags - this is the load-bearing guarantee that automated E2E can never
spend real API money. A test claiming "live decode tested" while `IS_E2E=1` was set is mislabeled.

## Reading test output
`npm run test` runs BOTH vitest projects (unit+dom) - a "94 passed" style count without a project
breakdown may be partial. Always `cd` into the inventory dir explicitly before any bare `vitest`
invocation - running from a parent directory silently matches unrelated files (false green).
