# Revision Gate (required before "ready for Santiago")

Human-bot proof is REQUIRED before handoff for any change touching scanner resolution, inventory,
roles/auth, exports, catalog, aliases, or product data. Unit tests passing is NOT sufficient — the leak
that motivated this gate (a tire part number resolving to a cigarette product) passed unit tests.

## Before marking any feature / hotfix / PR ready, run:
1. `npx vitest run` — unit/integration
2. `npx tsc --noEmit` — typecheck
3. `npx eslint src e2e` — lint
4. `npx next build` — build
5. `npx playwright test` — mock E2E (11 specs)
6. `npm run test:firebase` (+ `npm run test:e2e:firebase` when auth/Firestore changes)
7. **`npm run qa:bots`** — human-bot scenario(s) for the changed area
8. Run **SecurityLeakBot** if the change touches product data, barcodes, exports, roles, auth, catalog,
   aliases, or scanner resolution
9. Run **ConfusedHumanBot** if the change touches the UI
10. Save screenshots + reports under `reports/human-bots/latest/`

`npm run qa:revision` chains the standard gate + bots. If cloud credentials are unavailable, run the
emulator/local equivalent and clearly mark cloud-specific items untested.

## Track 1 bot commands (per changed area — see docs/AGENT_BOT_ROLES.md)
- `npm run qa:bots:tire` — scanner/resolution/normalization changes (+ `qa:bots:live` with GOD creds for the real account)
- `npm run qa:bots:security` — roles/auth/exports/products/catalog/aliases/API/Firebase rules/localStorage/customer UI
- `npm run qa:bots:data` — sync/cache/import/export/counting changes
- `npm run qa:bots:ux` — any UI change
- `npm run qa:bots:manager`, `npm run qa:bots:performance` — workflow / perf-sensitive changes
- `npm run qa:bots:all` — everything (mock). Every bot writes screenshots + JSON + a markdown report.

## Handoff statement (required)
Every "ready" report must state, per claim, whether it was **automated / mocked / live / manual / untested**,
and must answer for scanner/resolution changes: *did a browser bot paste the code and prove the result?*
If a bot found a gap, the report must say what was fixed and show the re-run passing — or name the blocker.

## Doctrine
"Human bot proof is required before handoff for scanner, inventory, role, export, catalog, alias, and
product-resolution changes." Do not claim a resolution fix works unless a browser bot proved it through
the real UI with a screenshot.
