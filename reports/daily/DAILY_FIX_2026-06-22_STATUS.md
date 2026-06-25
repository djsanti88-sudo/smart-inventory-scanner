# Daily Fix Mission — 2026-06-22 (Smart Inventory Scanner)

Branch: `decoder-hardening-v1-local` · Working dir: `C:\Users\djsan\inventory`
Mode: LOCAL only. **Nothing pushed / merged / deployed.** `npm run dev` runtime = **MOCK** (no Firebase).
All 5 priority phases executed in order (correctness/safety > ease-of-use > design).

## Per-phase summary

### P1 (P1) — Customer keeps pending review items + scan feed across reload — commit `7f5a0f1`
`buildPersistedScanState` dropped `needsReviewQueue` + `scanFeed` for the customer role, so a full reload
wiped every "Check these" row (badge → 0) and the customer's unfinished work could never be approved/counted.
- Customer now persists a **sanitized** `needsReviewQueue` (allowlist of act-on-it fields + the user's OWN
  `cleanCode`) and `scanFeed` (activity log **without** `cleanCode` — a matched feed row's code→product
  mapping is a slice of the reusable DB and must not persist).
- New allowlist sanitizers `sanitizeReview` / `sanitizeScanEvent` strip every provider/decode internal and
  every OTHER reusable code; no alias/catalog data reaches disk.
- `resolveUnknown`: `processScan(rawCode || cleanCode)` + null-safe `normalizedCandidates`/`sourceUrls`, and
  `NeedsReviewTable` made null-safe (`sourceUrls`/`verifiedFacts`/`guesses`) so a rehydrated/partial review
  never crashes the render.
- Files: `src/services/security/sensitiveFields.ts`, `serializers.ts`, `src/stores/scanPersist.ts`,
  `scanPersist.test.ts`, `src/stores/scanStore.ts`, `src/components/NeedsReviewTable.tsx`,
  `e2e/human-bots/scenarios/customer-review-persistence.spec.ts`.
- Proof: bot scans 3 unknowns → `/review` shows 3 → **full reload** → still 3 → badge == rows → approve one →
  badge 2 → item counted (screenshots 01–03). Leak bot stays green (a known scan persists no code).

### P2 (P2) — No duplicate product for the same identity (barcode-in-name) — commit `340e2c4`
Re-scanning `029142712886` minted a new row though a counted "UPC 029142712886 - Discoverer A/T3 E (10 Ply)
BW" already existed; create-new dedup keyed on identifier FIELDS, but the legacy product carried the barcode
only in its NAME.
- New pure `productDedup`: `blobContainsCodeToken` (exact WHOLE-token match, never fuzzy/substring; min length
  6 so a tire size/load index/year is never mistaken for a code) + `codeFromNamePrefix`.
- create-new dedup now also reuses a still-counted product whose NAME contains the scanned code as an exact
  token; **>1 match → conflict (Needs Review), never a guess**.
- Reversible **identifier backfill** (platform-only maintenance, NOT auto-run): dry-run preview → apply →
  Undo, surfaced in `CleanupRecommendations`.
- Files: `src/services/productDedup.ts` (+test), `src/stores/scanStore.ts` (+test),
  `src/components/CleanupRecommendations.tsx`, `e2e/identifier-backfill.spec.ts`.
- Proof: productDedup (7) + scanStore dedup/conflict/backfill (3) unit tests; backfill UI bot preview→apply→
  Undo (screenshots 04–05). Invariants intact (see below).

### P3 (P2) — Stop leaking jargon + raw errors to the 65+ customer — commit `821ca77`
- `settings`: Business ID value, the **Scanner** section (Submit mode / Debounce (ms)) and the **Sync** section
  (pending sync queue / idempotent sync) are now `isPlatform`-only. Customer Settings = Export + Clean up +
  Danger zone only.
- `SyncStatusBar`: raw `lastSyncError` is platformOwner-only; customer sees "Some items haven't saved yet.
  Tap Try saving again."
- Files: `src/app/(app)/settings/page.tsx`, `src/components/SyncStatusBar.tsx`,
  `e2e/human-bots/scenarios/customer-settings-plain.spec.ts`, `e2e/identifier-backfill.spec.ts` (platform
  cross-check).
- Proof: customer Settings body contains none of idempotent/Debounce/"ms)"/pending sync queue/Business ID/
  Submit mode/AI terms; keeps Export + Clean up (screenshot 06). Platform view confirmed UNCHANGED (still
  shows all of them). Both leak bots (role + export) green.

### P4 (P3) — Elderly-readable daily controls + contrast — commit `928108f`
- Needs Review + Counts action buttons and the link `<select>` are now **≥44px tall, text-base**. ONE primary
  per review row (Approve when a suggestion exists, else Link) is blue-filled; others are same-size outlines;
  destructive stays red. Create inputs 44px/text-base.
- Contrast: `text-zinc-400` on white → zinc-600/700 (ImageHoverPreview, review guesses/no-suggestion/
  resolution). Status/sync/decode/match badges + review cells raised from text-xs to text-sm.
- Scan page: the secondary "More options" `<details>` is **collapsed by default for real users**; stays
  expanded under E2E (`NEXT_PUBLIC_E2E_AUTH_BYPASS`, set only in the Playwright webServers, never in prod).
- Files: `src/components/NeedsReviewTable.tsx`, `FinalCountTable.tsx`, `badges.tsx`, `ImageHoverPreview.tsx`,
  `src/app/(app)/scan/page.tsx`, `e2e/human-bots/scenarios/customer-readable-controls.spec.ts`.
- Proof: bot asserts every Needs Review + Counts control renders ≥44px (screenshots 07–08); ConfusedHumanBot
  (qa:bots:ux) green; main mock Playwright suite 20 passed.

### P5 (P3) — Cleaner product names (no raw UPC / fitment junk) — commit `b973db1`
- New pure `customerDisplayName`: strips a leading "UPC|EAN|GTIN|Barcode <code> - " prefix and a trailing
  "Fits …" clause. **Render-only** — never mutates stored data; platformOwner sees the raw name. Requires
  whitespace before "Fits" so it never strips inside "Benefits"/"Outfits"; never returns empty.
- Applied in `FinalCountTable` + products page, gated `isPlatform ? raw : clean`.
- Files: `src/services/displayName.ts` (+test), `FinalCountTable.tsx`, `src/app/(app)/products/page.tsx`,
  `e2e/human-bots/scenarios/customer-clean-names.spec.ts`.
- Proof: displayName unit (5, incl. the "Benefits" false-positive guard found + fixed during TDD);
  customer Counts shows "Defender LTX M/S 275/70R18" with no "UPC …"/"Fits" (screenshot 09).

## Verification results (paste counts)

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | clean (0 errors) |
| `npx eslint src e2e` | **0 errors**, 4 warnings (all pre-existing, unrelated) |
| `npm run test` (vitest) | **663 passed**, 30 skipped, 0 failed (started 648; +15 new) |
| `npx next build` | Compiled successfully |
| Main Playwright suite (`playwright.config.ts`) | **20 passed** |
| Human bots (`playwright.bots.config.ts`, all) | **12 passed** (8 existing + 4 new daily bots) |
| `qa:bots:security` (role + export leak) | passed (no leak regression; SecurityLeakBot findings `[]`) |
| `qa:bots:tire` / `qa:bots:data` / `qa:bots:ux` | passed |
| Invariants: autoCountTire + decodeCorroboration + scanContextFirewall + poison | **37 passed** |

> Note: `npm run lint` (no path) lints the WHOLE repo including build artifacts / generated JSON / data dirs
> and reports a large pre-existing baseline of problems unrelated to this work. The meaningful project gate is
> `npx eslint src e2e`, which is **0 errors** — this mission added zero lint errors.

## Screenshots — `e2e/proof/daily-2026-06-22/`
`01-review-before-reload.png` · `02-review-after-reload.png` · `03-approved-after-reload-counted.png` ·
`04-backfill-before.png` · `05-backfill-after.png` · `06-customer-settings.png` · `07-review-controls.png` ·
`08-counts-controls.png` · `09-customer-clean-names.png`

## Local commits (in order)
- `7f5a0f1` fix(P1): customer keeps pending reviews + scan feed across reload
- `340e2c4` fix(P2): dedup barcode-in-name; reversible identifier backfill
- `821ca77` fix(P3): hide engineer jargon + raw errors from the customer
- `928108f` fix(P4): elderly-readable daily controls + contrast + decluttered scan page
- `b973db1` fix(P5): clean customer-facing product names (no raw UPC / fitment junk)

## Safety invariants — confirmed still passing
- **Poison `745125495781`** → never a corpus hit, routes to Needs Review, never auto-counts (poison +
  scanContextFirewall tests green).
- **Auto-count gate UNCHANGED**: decode.ts STRONG-tier prefix family + full specs + app-verified evidence,
  AND store gate (`status===verified` + `exactCodeEvidenceVerifiedByApp` + `confidence>=0.9` + firewall).
  Two-provider-agree path untouched. autoCountTire HARD INVARIANT + decodeCorroboration green.
- Every `data-testid` preserved; platform/customer gate (`isPlatform` / `useIsPlatformOwner`) preserved and
  extended (P3). SecurityLeakBot `[]`.

## Intentionally deferred / honest limitations
- **P1 scan feed after reload shows no barcode column** for already-matched rows (by design: persisting a
  matched code→product mapping is a reusable-DB leak). Product name + qty + status survive; the code is on
  the physical item and shown live during the session. The acute bug (lost *review* items) is fully fixed.
- **P2 identifier backfill** is a platform-only convenience; correctness no longer depends on it (the
  name-token dedup fixes re-scans at scan time regardless). Its Undo is in-session (not persisted across a
  full reload), which is sufficient for a maintenance action.
- **P4 collapsed `<details>`** is verified by the env-gated logic + code review; under the Playwright configs
  the flag forces it open (so tests/power users keep every control reachable), so the collapsed state itself
  is not screenshotted. Button-size acceptance (≥44px) IS asserted live (bot).

## Known risks
- The display-name cleaner (P5) and name-token dedup (P2) are heuristic string ops; both are conservative
  (exact code token only; "Fits" requires a leading space; never returns empty) and fully unit-tested,
  including the "Benefits" false-positive. Stored data is never mutated by P5.
- `.env.local` contains `NEXT_PUBLIC_FIREBASE_BACKEND=1` (pre-existing, not changed here); `scripts/dev.mjs`
  forces MOCK for `npm run dev` regardless (runtime log confirms "MOCK backend — no Firebase"). Use
  `npm run dev:prod` only for deliberate production.

## Rollback (per phase, local)
```
git revert b973db1   # P5 clean names
git revert 928108f   # P4 readable controls
git revert 821ca77   # P3 hide jargon
git revert 340e2c4   # P2 dedup + backfill
git revert 7f5a0f1   # P1 customer persistence
```
Each phase is an isolated commit; revert any subset (newest first to avoid conflicts).

## Confirmation
Nothing pushed, merged, or deployed. No Firebase/RTDB writes. `npm run dev` running on :3000 = MOCK.
Poison + auto-count invariants pass. Branch `decoder-hardening-v1-local`.
