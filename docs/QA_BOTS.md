# Human-like QA Bots (Track 1)

Browser bots (Playwright) that use the app the way real people do — they paste a barcode / QR / SKU /
part number into the scan input and press Enter (no physical scanner needed), then read the result from
the actual UI and screenshot every step. The point is to catch the kind of leak that unit tests miss:
"the report said the tire fix worked, but the part number still resolved to the wrong product." Human-bot
proof is REQUIRED before handoff for any change touching scanner resolution, inventory, roles/auth,
exports, catalog, aliases, or product data — unit tests passing is NOT sufficient. The leak that
motivated this gate (a tire part number resolving to a cigarette product) passed unit tests.

## Run

```
npm run qa:bots          # all human-bot scenarios
npm run qa:bots:tire     # tire resolution + mismatch guard
npm run qa:bots:security # export/leak protection
npm run qa:bots:data     # sync/cache/import/export/counting changes
npm run qa:bots:ux       # confused-human + manager-insight UX checks
npm run qa:bots:manager  # shop-manager workflow coverage
npm run qa:bots:performance # load + scan responsiveness
npm run qa:bots:all      # everything (mock)
npm run qa:bots:live     # RegressionBot on the real god account (needs GOD_EMAIL/GOD_PASSWORD)
npm run qa:revision      # full gate (tsc, eslint, build, playwright, firebase) + bots
```

Backend: mock/local (seed data + auth bypass), pinned in `playwright.bots.config.ts` on port 3300 so it
never collides with the mock (3100) or firebase (3200) runs and is independent of `.env.local`. The live
bot uses `playwright.bots.cloud.config.ts` against the real god account. Stop any running `next dev`
first — Next allows only one dev server per project directory.

## Personas

| persona | command | what it proves / reports | status |
|---------|---------|--------------------------|--------|
| PlatformOwnerBot (tire regression) | `npm run qa:bots:tire` | Falken part number in all separator shapes (- · none · space · / · \ · _ · .) + barcode resolve to Falken, never Camel | RUNNING (passing) |
| RegressionBot (live cloud) | `npm run qa:bots:live` (needs GOD_EMAIL/GOD_PASSWORD) | same, on Santiago's REAL god account | RUNNING (passing) |
| SecurityLeakBot | `npm run qa:bots:security` | SAFE, report-only: which internal fields a customer browser holds/sees | RUNNING (reports current exposure) |
| ExportBot | `npm run qa:bots:security` | export CSV headers; flags code-bearing exports | RUNNING |
| DataIntegrityBot | `npm run qa:bots:data` | increment correctness, refresh persistence, unknown -> Needs Review | RUNNING (passing) |
| ConfusedHumanBot | `npm run qa:bots:ux` | no-training UX scorecard + top confusions (incl. mobile) | RUNNING (report-only) |
| ManagerBot | `npm run qa:bots:manager` | shop-manager workflow coverage + missing-feature classification | RUNNING (report-only) |
| PerformanceBot | `npm run qa:bots:performance` | load + scan responsiveness + local payload smoke | RUNNING (report-only) |
| ShopOwnerBot / AdminBot / CounterBot / ViewerBot | (folded into SecurityLeak/Export today) | role-segregated visibility | PARTIAL — needs the deferred client-side role model to be meaningful (single auth-bypass user today) |

Target set (some folded into the bots above until the role foundation lands): PlatformOwnerBot,
ShopOwnerBot, CounterBot, ViewerBot, ConfusedHumanBot, ManagerInsightBot, SecurityLeakBot, RegressionBot.

## Pre-handoff checklist

Before marking any feature / hotfix / PR ready, run:
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

### Bot command per changed area
- `npm run qa:bots:tire` — scanner/resolution/normalization changes (+ `qa:bots:live` with GOD creds for the real account)
- `npm run qa:bots:security` — roles/auth/exports/products/catalog/aliases/API/Firebase rules/localStorage/customer UI
- `npm run qa:bots:data` — sync/cache/import/export/counting changes
- `npm run qa:bots:ux` — any UI change
- `npm run qa:bots:manager`, `npm run qa:bots:performance` — workflow / perf-sensitive changes
- `npm run qa:bots:all` — everything (mock). Every bot writes screenshots + JSON + a markdown report.

### Handoff statement (required)
Every "ready" report must state, per claim, whether it was **automated / mocked / live / manual / untested**,
and must answer for scanner/resolution changes: *did a browser bot paste the code and prove the result?*
If a bot found a gap, the report must say what was fixed and show the re-run passing — or name the blocker.

## Honest limitations

- **Role segregation is not testable end-to-end yet** because client-side role gating is part of the
  DEFERRED foundation (docs/HOTFIX_FOLLOWUPS.md). The role bots therefore report the CURRENT single-role
  exposure truthfully (everything visible to everyone) instead of asserting gates that don't exist.
- SecurityLeakBot is strictly non-destructive: visibility/storage/export inspection only. No exploits,
  no writes, no auth attacks.
- The mismatch guard needs identity evidence (a lookup suggestion, or the code already mapping to another
  category) to flag a cross-category mislink; a brand-new numeric code with AI off cannot be classified.
- Online barcode-accuracy samples are exploratory only (legal public pages, small samples, source URL
  recorded) and never populate a production catalog.

## Outputs

`reports/human-bots/latest/`: summary.md, tire_resolution_result.json (+ planned: failures.json,
scenario_results.csv, security_leak_report.md, ux_scorecard.md, manager_insights.md,
barcode_accuracy_samples.csv, screenshots_index.md). Screenshots in `e2e/proof/human-bots/`.

## Doctrine

"Human bot proof is required before handoff for scanner, inventory, role, export, catalog, alias, and
product-resolution changes." Do not claim a resolution fix works unless a browser bot proved it through
the real UI with a screenshot.

## Safety

No public deploy, no destructive cloud writes, no auth/CAPTCHA/paywall bypass. The live bot only reads +
scans on the owner's own account.

## See also

`docs/SCHEDULED_QA_BOTS.md` covers a separate (scheduling) concern — running this same bot suite
automatically on a weekly cadence. It does not change how or when to run bots manually per this doc.
