# Human Bot Summary — latest run

**Headline: PR #4's tire fix is PROVEN through the browser. Scanning `2881-6861` resolves to the Falken
tire, NOT Camel Crush Menthol Silver Cigarettes.** The bot also caught one real gap (slash separator),
which was fixed and re-proven in the same loop.

Run via: `npm run qa:bots:tire` (mock/local backend, port 3300, screenshots in `e2e/proof/human-bots/`).

## Answers to the required questions
1. **Did `2881-6861` still resolve to Camel?** NO. It resolves to "Falken Sincera ST80 A/S" (Known). Browser-proven.
2. **Did `28816861` resolve correctly?** YES — Falken (Known). Same for space `2881 6861` and slash `2881/6861`.
3. **Did the mismatch guard block tire → cigarette?** Partially. The guard blocks when there is identity
   evidence for the code (an AI/web suggestion, or the code already maps to a product of another category)
   — proven by unit/store tests. **Honest limitation:** for a brand-new numeric code with NO lookup
   evidence and AI off, the app cannot *know* it's a tire, so a human could still mislink it. This is a
   detection limit, not a regression. Strengthening it depends on the deferred server-side lookup/global
   catalog (see docs/HOTFIX_FOLLOWUPS.md). Tracked in `ux_backlog`/follow-ups, not faked as passing.
4. **Did any customer role see raw codes?** Not yet testable end-to-end: **role-based code hiding is part
   of the DEFERRED foundation and is NOT built**. Today every authenticated user sees codes. The
   SecurityLeakBot scenario therefore reports the CURRENT truth (codes visible to all) rather than
   pretending a role gate exists. This is the #1 deferred item before a real shop pilot.
5. **Could a normal counter use the app with minimal training?** Not yet bot-evaluated (ConfusedHumanBot
   scenario pending). Manual observation: the scan input is the focused default and the live feed gives
   immediate feedback, which is good; a full UX scorecard is the next increment.
6. **UX problems that would confuse a shop owner?** Pending the ConfusedHumanBot/ManagerInsight scenarios.
7. **Missing manager features?** Pending the ManagerInsightBot scenario.
8. **What was fixed during the loop?** The slash-separated part number (`2881/6861`) was going to Needs
   Review; `buildNormalizedCandidates` now strips all common separators (`-`, space, `/`, `\`, `_`, `.`),
   so it resolves to Falken. Re-proven by the bot + scanCleaner unit tests (13/13).
9. **What remains blocked / pending?** The remaining persona scenarios (shopOwner, counter, viewer,
   ConfusedHuman, ManagerInsight, SecurityLeak, online-barcode loop) and the role-based security tests,
   which depend on the deferred platform/customer role foundation.
10. **Is PR #4 ready for Santiago to test?** YES for the tire multi-code resolution + repair (browser-proven).
    NOT a substitute for the deferred role/security foundation before letting outside shops in.

## Scenario results (this run)
| scenario | bot | result | proof |
|----------|-----|--------|-------|
| Falken part number, every separator → never Camel | PlatformOwnerBot | PASS | tire_resolution_result.json + e2e/proof/human-bots/tire-resolution/*.png |

## Loop record
- Loop 1: ran tire bot → caught `2881/6861` → Needs Review (slash not normalized).
- Fix: `scanCleaner.buildNormalizedCandidates` strips all common separators (additive; exact-array unit tests still pass).
- Loop 2: re-ran tire bot → all separator shapes resolve to Falken, none to Camel → PASS.

## Honest status
- **Built + proven now:** the human-bot harness (`playwright.bots.config.ts`, `npm run qa:bots*`), the
  critical PlatformOwner tire-resolution scenario, and a real gap fix. Phase B revision gate documented.
- **Not yet built (next increments):** the other 7 personas/scenarios, the online-barcode accuracy loop,
  UX scorecard, manager-insights report, and the role-based SecurityLeak tests (the last group needs the
  deferred role foundation to exist before it can pass rather than just report current state).
- Nothing here is faked: every claim above is backed by a screenshot + JSON or a named unit test.
