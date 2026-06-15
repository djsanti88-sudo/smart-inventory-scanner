# Track 1 Master Report — Bot Army, Security, UX, Manager, Revision Gate

## 1. Executive summary
A human-like Playwright bot army now drives the real UI (paste codes, read results, screenshot). The
Falken/Camel tire regression is preserved and broadened to all 7 separator shapes + barcode (none resolve
to Camel) and is guarded by a LIVE god-account bot. Safe, non-destructive security/export/data/UX/manager/
performance bots run and produce reports. The headline P0 finding is honest: **the customer browser holds
the alias/catalog database and code columns/exports are visible to every role today** — because the
platform/customer role foundation is still deferred. No app `src/` logic was changed in Track 1.

## 2. Branch / commit
`qa-agent-army-track1` (off `qa-human-bots`). Inherits all tire/live/bot fixes.

## 3. Fixes preserved from qa-human-bots
Separator normalization (dash/none/space/slash/backslash/underscore/dot), multi-code capture, mismatch
guard, alias repair (unlink/move), Products-page infinite-render fix, clearLocalCache cloud-safe fix, live
cloud account repair + live regression bot.

## 4. Bots built
PlatformOwner tire-regression, RegressionBot (live cloud), SecurityLeakBot, ExportBot, DataIntegrityBot,
ConfusedHumanBot (UX), ManagerBot, PerformanceBot. (ShopOwner/Admin/Counter/Viewer role bots are PARTIAL —
folded into the security/export bots — pending the deferred client-side role model.) See docs/AGENT_BOT_ROLES.md.

## 5. Tested in real browser (mock seed)
All 7 mock scenarios pass: `npm run qa:bots:all` → 7 passed. Screenshots in `e2e/proof/agent-bots/*`.

## 6. Tested in emulator
Firebase rules/tenant-isolation + Firebase E2E remain green from baseline (no src change this track).

## 7. Tested in live cloud
`npm run qa:bots:live` (real god account) PASS — 2881-6861 / 28816861 / 2881 6861 / 2881/6861 all → Falken.

## 8. Falken/Camel regression result
PASS, all shapes → Falken, none → Camel (see tire_regression.md).

## 9. Security leaks found (SAFE report; current deferred-state)
- **P0:** customer browser holds the alias database + shared catalog in localStorage (downloadable).
- **P0:** Products page shows raw code columns (barcode/GTIN/UPC/EAN/aliases) to any logged-in user.
- **P1:** customer-facing UI exposes internal terms ("AI lookup", Gemini, OpenAI, provider) in Settings/feed.
All are the DEFERRED role/data-protection foundation, not regressions. (security_leak_report.md)

## 10. Export leaks found
Code-bearing exports (final counts, products, aliases, raw scan log) are available with raw code fields to
the single current role → must be platformOwner-only/sanitized before non-owner roles exist. (export_leak_report.md)

## 11. UX friction found
Core tasks discoverable (scan, feed, count, export, sessions, mobile). Main friction: internal wording
("AI"/provider) shown to customers; "Needs Review" copy could be plainer. (ux_scorecard.md, top_ux_confusions.md)

## 12. Manager workflow insights
Present: live feed/scan log, final count, sessions, exports, Needs Review, product DB, alias repair.
Missing (recommended): per-user attribution, finished-session history, product search, audit-history UI,
stock targets/low-stock (add-on), multi-location (enterprise), part-number-only import (deferred add-on). (manager_insights.md)

## 13. Data integrity issues found
None. Increment correctness, refresh persistence, unknown→Needs Review all PASS; idempotency/ambiguity
locked by unit/store tests. (data_integrity_report.md)

## 14. Performance smoke
Load + scan responsiveness within budget. Caveat: localStorage carries the alias/catalog DB (grows with
the catalog) — another reason for the deferred server-side customer resolution. (performance_smoke.md)

## 15. Fixed during loops
Tire regression broadened to backslash/underscore/dot (the normalizer already handled them; coverage added).
No new code bugs surfaced this track (the Products-page crash + clearLocalCache crash were already fixed on qa-human-bots).

## 16. Remaining pending
The deferred platform/customer role + data-protection foundation (the source of every P0 above), and the
partial role-segregated bots that depend on it.

## 17. Priorities
- **P0:** build the role/data-protection foundation (server-side customer resolution + role-aware
  serializers + customer code hiding + stop shipping the alias/catalog DB to customer browsers).
- **P1:** de-brand customer-facing "AI"/provider wording; audit-history + finished-session UI for managers.
- **P2:** product search, plainer Needs Review copy, per-user scan attribution.
- **P3:** stock targets / low-stock alerts (add-on), part-number-only import + enrichment.

## 18. Screenshots
`e2e/proof/agent-bots/{security,data-integrity,export,ux,manager,performance}/`,
`e2e/proof/human-bots/{tire-resolution,cloud,live-repair}/`.

## 19. Commands run + results
tsc clean · eslint 0 errors · vitest 373/30 skipped · build OK · `qa:bots:all` 7 passed · `qa:bots:live` PASS.
Heavy app gates (mock Playwright 11/11, test:firebase 30/30, Firebase E2E) unchanged from baseline (no src change).

## 20. PR #4 fold-in safety
PR #4 (`hotfix-multicode-tire-resolution`) lacks the slash/backslash/etc. normalization, Products-page fix,
clearLocalCache fix, and bots. Recommend a **follow-up PR** from `qa-agent-army-track1` (or fold qa-human-bots
+ this branch in) rather than editing PR #4 in place. No auto-merge.

## 21. Next recommended milestone
Build the **platform/customer role + data-protection foundation** (P0). It converts the SecurityLeakBot/
ExportBot from "report current exposure" into hard pass/fail gates and is the prerequisite before any
non-owner shop user touches the app.
