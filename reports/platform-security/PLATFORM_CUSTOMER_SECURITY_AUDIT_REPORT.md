# Platform vs Customer Security Audit (P0, audit-first)

## 1. Executive summary
The app currently has **no platformOwner concept and no role-based data gating**. Every business member
(owner/admin/counter/viewer) downloads the full **alias table** + product **code fields** into the browser
(and localStorage), can **export** them, and the **global `catalogEntries`** collection is readable by
*any signed-in user across businesses* (and is read client-side). This means a customer could reconstruct
Santiago's reusable barcode/alias/catalog database. These are **P0** and must be fixed before any outside
shop uses the app. The fix is architectural (split customer-facing vs internal data + server-side
sanitized resolution), not a UI-column patch — Firestore can't hide individual fields.

## 2. Branch and commit
Branch `p0-platform-customer-security-audit` (audit only; no implementation commits). Latest base commit
inherited from `qa-agent-army-track1`.

## 3. Base branch used
`qa-agent-army-track1` — confirmed to contain the tire live-account fix, all separator normalization
(`- none space / \ _ .`), clearLocalCache cloud-safe fix, Products-page fix, and the bot framework/revision gate.

## 4. Tire/live fixes preserved
Verified in preflight: `qa:bots:tire` PASS (all shapes → Falken) and `qa:bots:live` PASS on the real god
account (2881-6861 / 28816861 / 2881/6861 → Falken, none → Camel). vitest 373/30, tsc clean, build OK.

## 5. Current platformOwner identification mechanism
**None.** `Role = "owner" | "admin" | "counter" | "viewer"` are *business memberships*. The "god account"
(djsanti88@gmail.com, uid `nDPz45mqDMaaucovnl4y5v5vhSH3`) is just a business **owner**, indistinguishable
in code from a customer's shopOwner. There is no platform-level flag and no server-side platformOwner check.

## 6. Recommended platformOwner identification mechanism
A **server-side allowlist**, not a business role:
- `PLATFORM_OWNER_EMAILS` (e.g. `djsanti88@gmail.com`) and/or `PLATFORM_OWNER_UIDS`
  (e.g. `nDPz45mqDMaaucovnl4y5v5vhSH3`), read server-side only (env, not committed; `.env.local` stays untracked).
- A customer business role `owner`/`admin` must **never** auto-become platformOwner.
- Checked in the resolve/loader/export endpoints and (where used in rules) via a guarded mechanism.
- Later option: a Firebase custom claim set by a trusted server process. Do not let client/localStorage decide it.

## 7. Data-flow audit summary
See `data_flow_audit.md`. Raw codes/aliases reach the browser via `businessDataLoader` (direct Firestore
client reads of `aliases` + `products`) and the global `catalogEntries` query in `repositories.ts`; persist
to localStorage `sis-scan-v1`; are shown in 5 UI surfaces; and are exportable with no role gating.

## 8. Sensitive localStorage findings
`sis-scan-v1` persists `products` (code fields), the full `aliases` table, `scanFeed` (raw/clean codes),
`needsReviewQueue` (raw codes), `finalCounts`, `pendingSyncQueue`. The reusable code DB lives in the browser.

## 9. Sensitive network/API findings
No server serializer exists; the browser reads raw Firestore docs directly (`businesses/{bid}/aliases`,
`/products`) and the global `catalogEntries`. `/api/ai-lookup` returns provider/evidence fields.

## 10. Sensitive export findings
`csvExport.ts` has **zero** role/sanitize logic. `exportAliases` dumps the entire alias map; products/final-
count/qty/raw-log/unknowns exports all include code fields. All reachable by any role via `ExportButtons`.

## 11. Sensitive UI findings
Products (SKU/barcode/GTIN-UPC-EAN/aliases), LiveScanFeed (raw/clean code), FinalCountTable (SKU/barcode/
aliases), NeedsReviewTable (raw/clean code + provider/evidence), Settings ("AI lookup", Gemini/OpenAI).

## 12. Firestore direct-read risks
`aliases`, `products`, `scanEvents`, `inventoryCounts`, `unknownCodeReviews`, `shopOverrides`, `settings`
→ readable by **any** member (incl. counter/viewer). **`catalogEntries` → readable by any signed-in user
(cross-business)**, and read client-side. auditLog is correctly owner/admin-gated.

## 13. Documents that mix customer-facing + internal fields
`products/{id}` (display fields + barcode/gtin/upc/ean/aliases), `scanEvents/{id}` and
`unknownCodeReviews/{id}` (display + rawCode/cleanCode/normalizedCandidates).

## 14. Why Firestore field-level hiding is not enough
Rules grant/deny whole documents. A customer who can read `products/{id}` receives its code fields over the
wire regardless of UI. Fix = split internal fields into separate docs/subcollection, OR stop customer
direct-reads and serve sanitized data via a server endpoint, OR keep aliases/catalog server-only + resolve
scans server-side.

## 15. Recommended implementation phases
(1) platformOwner identity (allowlist) → (2) role-aware serializers + sensitiveFields denylist → (3) customer
product loader + localStorage split (stop persisting aliases/full products for customers) → (4) `/api/resolve-scan`
server-side resolution for customers → (5) sanitized exports → (6) Firestore hardening (careful, emulator-tested,
revert-on-failure) → (7) customer-safe de-branding → (8) bot proof (SecurityLeak/Export/Role/Data/tire/live/UX).

## 16. Exact files to change
See data_flow_audit §11. New `src/services/security/*`, `src/app/api/resolve-scan/route.ts`; change
`businessDataLoader.ts`, `scanStore.ts` (partialize), `csvExport.ts`, `ExportButtons.tsx`, `firestore.rules`,
and the 5 UI surfaces; add platformOwner identity util.

## 17. Bot/tests needed for proof
SecurityLeakBot (UI/localStorage/network clean for customers), ExportBot (customer CSV sanitized),
RoleBot (platformOwner vs each role), DataIntegrity + tire + live (no regression), emulator rules tests
(counter/viewer denied aliases + catalogEntries), serializer unit tests (denylist incl. nested + unknown keys).

## 18. Risks
- Firestore rule changes can break the whole app + E2E → must be emulator-tested and reverted on failure (no blind loops).
- Moving resolution server-side changes the scan flow → must keep platformOwner local flow + offline behavior
  (queue the user's own scanned codes only) + no double count + tire/live regression intact.
- Mis-detecting platformOwner would either lock Santiago out or expose data → server-side allowlist + tests.

## 19. Approval checklist for Santiago
- [ ] Confirm platformOwner identity = `PLATFORM_OWNER_EMAILS`/`UIDS` allowlist (djsanti88@gmail.com / uid above).
- [ ] Approve the phased plan (serializers → loader/localStorage → server resolve → exports → rules → de-brand → bots).
- [ ] Approve that customer scan resolution moves **server-side** (customers lose pure-offline full resolution; offline = queue own scans, resolve on reconnect).
- [ ] Confirm Firestore rule changes are in scope (with emulator tests + revert-on-failure), or defer rules to a separate pass.
- [ ] Confirm NOT in scope: CSV enrichment, global/business alias data-model migration, schema migration.

## 20. Should implementation proceed?
**Not yet.** The leaks are confirmed and P0, but per the task this is audit-first. **Awaiting Santiago's
"Approved" before any Phase 2–9 code.** Nothing was changed beyond the audit reports.
