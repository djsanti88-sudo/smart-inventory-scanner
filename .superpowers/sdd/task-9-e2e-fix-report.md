# Task 9 follow-up: E2E regression fix report

## Summary

Both failing specs (`e2e/firewall.spec.ts`, `e2e/auto-count-tire.spec.ts`) had exactly ONE failing
test case each, and both were classified **(a) FIXTURE-REALITY**. No production source code was
touched. No spec assertions were changed.

## Root cause

Commit `93cca79` ("feat(firewall): category conflict advisory when app-verified") changed
`detectScanContextConflict` so that a non-tire product in tire scan context is no longer hard-blocked
when `exactCodeVerifiedByApp === true` (derived in `scanStore.ts` as
`decision?.exactCodeEvidenceVerifiedByApp === true && decision?.status === "verified"`).

Both E2E specs' mocked decode response for the poison code `745125495781` (the "Manstel aluminum
rivet kit" example, sourced from `go-upc.com` - the exact poisoned-source example cited in
`scanContextFirewall.ts`'s own doc comments) forced an unrealistic strong-evidence shape:
`status: "verified"` + `exactCodeEvidenceVerifiedByApp: true`. Under the new rule this now clears the
category hard-block instead of blocking it, so the row counted with an `offCategory` tag and never
appeared in Needs Review under `review-row-745125495781` - which is what both tests waited for.

This is confirmed NOT achievable by the real `EvidenceVerifier`
(`src/services/ai/evidenceVerifier.ts`): a `go-upc.com` URL with no fetched page text produces
`strength: "url_only"`, and `url_only` is only counted `verified` when the host is in an explicit
trusted allowlist (line 167-170: "url_only is strong when VERIFIED (= the URL is from an explicitly
trusted host: Amazon, Walmart, Target, major retailers, GS1 registries, barcode DBs)"). `go-upc.com`
is the canonical UNtrusted/poison source named in the module's own header comment ("go-upc.com maps
tire UPC 745125495781 to an aluminum-rivet kit" - line 4-5 of `scanContextFirewall.ts`). So the real
pipeline could never produce `exactCodeEvidenceVerifiedByApp: true` for this fixture; the mock was
stale, matching the established precedent from the same commit's own unit-test migration
(`src/stores/scanStore.test.ts` line 908-926, "TASK 9 poison guard intact" test, uses
`status: "suggested"`, `evidenceStrength: "url_only"`, `exactCodeEvidenceVerifiedByApp: false` for the
identical scenario).

## Per-failure classification

| Spec | Test | Class | Fix |
|---|---|---|---|
| `e2e/firewall.spec.ts:39` | "firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review" | (a) FIXTURE-REALITY | Migrated `POISONED.decision` mock body: `status: "verified"` → `"suggested"`, `confidence: 0.92` → `0.6`, `evidenceStrength: "fetched_source"` → `"url_only"`, `exactCodeEvidenceVerifiedByApp: true` → `false`. Assertions untouched. |
| `e2e/auto-count-tire.spec.ts:44` | "corroborated tire auto-counts on live scan; poison stays in Needs Review" | (a) FIXTURE-REALITY | Migrated `DECODE["745125495781"].decision` mock body: same field changes as above (`status`, `confidence`, `evidenceStrength`, `exactCodeEvidenceVerifiedByApp`). The other fixture in this file (`029142712886`, the corroborated Cooper tire) was untouched - it is a real tire, not a poison/off-category case, and its expectations (auto-count, verified) are unaffected by the new rule. Assertions untouched. |

Both files only had ONE test case each and only ONE decode fixture in each needed migration (the
`029142712886` legitimate-tire fixture in `auto-count-tire.spec.ts` was already correct and required
no change). No (b) INTENT-CHANGE cases were found in either spec - neither test asserts hard-blocking
of a genuinely app-verified off-category product; both only assert hard-blocking of the WEAK-evidence
poison case, which is exactly the behavior the new rule preserves. No (c) real code regressions were
found.

## Changes made

- `e2e/firewall.spec.ts`: `POISONED.decision` fixture migrated to weak-evidence shape + explanatory
  comment (`owner-ratified 2026-07-14: advisory-when-app-verified (fixture migrated to real weak
  evidence shape)`).
- `e2e/auto-count-tire.spec.ts`: `DECODE["745125495781"].decision` fixture migrated to weak-evidence
  shape + same comment style.
- No production source files touched (`scanContextFirewall.ts`, `scanStore.ts`, `decode.ts` etc. all
  unmodified).
- No spec assertions were changed in either file.

## RED (before fix) - failing

```
Running 2 tests using 1 worker

  ✘  1 [chromium] › e2e\auto-count-tire.spec.ts:44:5 › corroborated tire auto-counts on live scan; poison stays in Needs Review (6.9s)
  ✘  2 [chromium] › e2e\firewall.spec.ts:39:5 › firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review (6.6s)

  1) [chromium] › e2e\auto-count-tire.spec.ts:44:5 › corroborated tire auto-counts on live scan; poison stays in Needs Review

    Error: expect(locator).toBeVisible() failed

    Locator: getByTestId('review-row-745125495781')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

      84 |   await page.goto("/review");
      85 |   const poisonReview = page.getByTestId("review-row-745125495781");
    > 86 |   await expect(poisonReview).toBeVisible();
         |                              ^
      87 |   await expect(poisonReview).toContainText(/category conflict/i);

  2) [chromium] › e2e\firewall.spec.ts:39:5 › firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review

    Error: expect(locator).toBeVisible() failed

    Locator: getByTestId('review-row-745125495781')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

      71 |   await page.goto("/review");
      72 |   const reviewRow = page.getByTestId(`review-row-${CODE}`);
    > 73 |   await expect(reviewRow).toBeVisible();
         |                           ^
      74 |   await expect(reviewRow).toContainText(/category conflict/i);
      75 |   await expect(reviewRow).toContainText(/needs review/i);

  2 failed
    [chromium] › e2e\auto-count-tire.spec.ts:44:5 › corroborated tire auto-counts on live scan; poison stays in Needs Review
    [chromium] › e2e\firewall.spec.ts:39:5 › firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review
```

## GREEN (after fix) - passing

Two-spec targeted run:

```
Running 2 tests using 1 worker

  ✓  1 [chromium] › e2e\auto-count-tire.spec.ts:47:5 › corroborated tire auto-counts on live scan; poison stays in Needs Review (2.0s)
  ✓  2 [chromium] › e2e\firewall.spec.ts:43:5 › firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review (1.6s)

  2 passed (9.4s)
```

Neighbor regression check (adds `e2e/suggested-decode.spec.ts`, which shares the app-verified /
suggested-decode logic and was not directly edited but is the closest neighbor to the changed rule):

```
Running 5 tests using 1 worker

  ✓  1 [chromium] › e2e\auto-count-tire.spec.ts:47:5 › corroborated tire auto-counts on live scan; poison stays in Needs Review (2.0s)
  ✓  2 [chromium] › e2e\firewall.spec.ts:43:5 › firewall: poisoned non-tire result in Tire context does not auto-count and routes to Needs Review (1.6s)
  ✓  3 [chromium] › e2e\suggested-decode.spec.ts:69:5 › suggested decode (confidence 0.92) shows identity + unconfirmed tag; review auto-closes (owner order 2026-07-10) (1.6s)
  ✓  4 [chromium] › e2e\suggested-decode.spec.ts:167:5 › Task 9b APPROVE: low-conf suggestion shows '(suggested, 30%)' + controls, no open review; approve clears the tag, keeps scanner focus, and the rescan is deterministic-known (no second decode) (2.0s)
  ✓  5 [chromium] › e2e\suggested-decode.spec.ts:209:5 › Task 9b DECLINE: ✕ renames the row to the safe placeholder and ONLY THEN opens the review (1.9s)

  5 passed (14.8s)
```

## Proof type

- Automated proof: yes (Playwright E2E, mocked `/api/ai-lookup` via `page.route`, `IS_E2E=1`
  webServer forces mock-only per repo convention). No live AI provider calls made.
- Mocked proof: all decode responses in these specs are mocked; this report's fix is itself a mock
  fixture migration.
- Live proof: none (out of scope, none requested).
- Manual proof: none needed; browser proof came from the Playwright run itself (headless Chromium via
  webServer on port 3100).
- Untested limitations: none identified for this specific regression; broader E2E suite was not run
  in full (only the two failing specs + their nearest neighbor spec, per task scope).

## Commit

`fix(e2e): migrate firewall/auto-count-tire specs to advisory-when-app-verified rule (Task 9 follow-up)`
