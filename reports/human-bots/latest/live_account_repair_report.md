# Live God-Account Repair Report (Falken / Camel)

My earlier "fixed" claim was wrong: it was proven on SEED data, not Santiago's real cloud account. The
live account had a poisoned alias in **cloud Firestore**. It is now repaired and proven on the live account.

## Required answers
1. **Did `2881-6861` exist as an approved alias on Camel in the cloud/god account?** YES.
   `business biz-nDPz45mqDMaaucovnl4y5v5vhSH3 / aliases/alias-33d57be0-9947-496a-a941-32566641235d`,
   `cleanCode "2881-6861"`, `normalizedCode "28816861"`, `approved: true`, `productId` → "Camel Crush
   Menthol Silver Cigarettes, Box".
2. **Where was it stored?** **Firestore / cloud** (source of truth). It was also mirrored into the
   browser's localStorage via the persisted store, but a reload re-fetches cloud — which is why "clear
   local cache" alone never fixed it.
3. **What exact repair was performed?** The alias was **moved** from the Camel product
   (`prod-128ac4db…`) to the real Falken tire (`prod-774eac9c…` = "UPC 848983012906 - Falken Sincera
   ST80 A/S … 215/70R15 98T"), keeping `approved: true`, via the in-app Products → Codes → **Move**
   control (and confirmed against cloud with `scripts/repair-god-alias.mjs`). **Scan history was not
   deleted.** Audit event written: `alias_moved_or_unlinked`, reason `human_mistake_repair_live_account`,
   `rawCode 2881-6861`, `normalizedCode 28816861`, `fromProduct Camel…`, `toProduct Falken…`.
4. **Proof `2881-6861` no longer resolves to Camel:** live UI feed → "Exact alias → Falken Sincera ST80
   A/S (Known)". Screenshots `e2e/proof/human-bots/live-repair/*` + `cloud/var-0.png`; JSON
   `reports/human-bots/latest/cloud_tire_resolution_result.json`.
5. **Proof `28816861` no longer resolves to Camel:** → Falken (Known). Same artifacts (`var-1.png`).
6. **Proof `2881/6861` no longer resolves to Camel:** → Falken (Known) (`var-3.png`). Slash now
   normalizes (scanCleaner fix).
7. **Does the Falken product exist / does the code resolve to it?** YES — `prod-774eac9c…`; all four
   shapes (`2881-6861`, `28816861`, `2881 6861`, `2881/6861`) resolve to it.
8. **Does Clear local cache work without a cloud-reset crash?** YES. In cloud mode it no longer calls
   `FirebaseSyncTarget.reset()`; it clears only browser-local data, shows "Local browser cache cleared.
   Cloud data was not deleted." and reloads cleanly. Verified live (Settings page reloaded healthy, no
   crash) + 2 unit tests.
9. **Test commands + results:** `npx tsc --noEmit` clean · `npx eslint src e2e` 0 errors ·
   `npx vitest run` 373 passed / 30 skipped · `npm run qa:bots:tire` (mock) PASS ·
   `GOD_EMAIL=… GOD_PASSWORD=… npm run qa:bots:live` (real cloud) PASS.
10. **Screenshots:** `e2e/proof/human-bots/cloud/` (live god account), `e2e/proof/human-bots/live-repair/`
    (before-Camel / after-move / after-Falken), `e2e/proof/human-bots/tire-resolution/` (seed).
11. **Is PR #4 ready now?** The tire multi-code resolution + the live poisoned-alias repair are **proven
    on Santiago's real account**. A permanent live-cloud regression bot (`qa:bots:live`) now guards it.
    Still pending before outside shops: the deferred platformOwner/customer role + data-protection
    foundation (docs/HOTFIX_FOLLOWUPS.md) — not part of this live repair.

## Process failure fixed
The earlier bot proof tested clean seed data, not the live account. Added `npm run qa:bots:live`
(real-cloud login, `e2e/human-bots/cloud/poisoned-live-account.spec.ts`) so future "ready" claims must
validate the actual account. Two real bugs were caught only by live testing: the Products page infinite-
render crash and the Clear-local-cache cloud-reset crash — both fixed.
