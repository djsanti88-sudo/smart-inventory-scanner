# Human-like QA Bots

Browser bots (Playwright) that use the app the way real people do — they paste a barcode / QR / SKU /
part number into the scan input and press Enter (no physical scanner needed), then read the result from
the actual UI and screenshot every step. The point is to catch the kind of leak that unit tests miss:
"the report said the tire fix worked, but the part number still resolved to the wrong product."

## Run
```
npm run qa:bots          # all human-bot scenarios
npm run qa:bots:tire     # tire resolution + mismatch guard
npm run qa:bots:security # export/leak protection
npm run qa:bots:ux       # confused-human + manager-insight UX checks
npm run qa:revision      # full gate (tsc, eslint, build, playwright, firebase) + bots
```
Backend: mock/local (seed data + auth bypass), pinned in `playwright.bots.config.ts` on port 3300 so it
never collides with the mock (3100) or firebase (3200) runs and is independent of `.env.local`.
Stop any running `next dev` first — Next allows only one dev server per project directory.

## Personas (target set)
PlatformOwnerBot (Santiago — sees everything), ShopOwnerBot, CounterBot, ViewerBot, ConfusedHumanBot
(minimal training), ManagerInsightBot (operational features), SecurityLeakBot (hunts raw-code/alias/
provider leakage from customer roles), RegressionBot (the known high-risk bugs).

## Built so far
- `playwright.bots.config.ts`, `e2e/human-bots/` (fixtures + scenarios), reports in `reports/human-bots/latest/`.
- **PlatformOwner tire-resolution** scenario (the critical proof): pastes `2881-6861`, `28816861`,
  `2881 6861`, `2881/6861`, and the barcode; asserts none resolve to Camel and all resolve to the Falken
  tire. Writes `tire_resolution_result.json` + screenshots.

## Honest limitations (today)
- **Role-based code hiding is DEFERRED** (docs/HOTFIX_FOLLOWUPS.md), so SecurityLeakBot reports the
  CURRENT visibility truthfully (all authenticated users see codes) rather than asserting a role gate that
  doesn't exist yet. Role-segregated bots become real once that foundation lands.
- The mismatch guard needs identity evidence (a lookup suggestion, or the code already mapping to another
  category) to flag a cross-category mislink; a brand-new numeric code with AI off cannot be classified.
- Online barcode-accuracy samples are exploratory only (legal public pages, small samples, source URL
  recorded) and never populate a production catalog.

## Outputs
`reports/human-bots/latest/`: summary.md, tire_resolution_result.json (+ planned: failures.json,
scenario_results.csv, security_leak_report.md, ux_scorecard.md, manager_insights.md,
barcode_accuracy_samples.csv, screenshots_index.md). Screenshots in `e2e/proof/human-bots/`.
