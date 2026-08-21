[STALE — snapshot of 2026-06-15; several items since done. Current truth: PROGRESS.md /
DEPLOY_TRUTH.md / REPO_HEALTH.md. Needs a refresh pass.]

# Hotfix follow-ups (deferred per "tires first, then add the rest to TODOs")

The full amendment (platform/customer security foundation) is intentionally DEFERRED until the tire
resolution fix is shipped and proven. Decisions already made by the owner:
- **Backend:** stay on Firebase/Firestore; enforce protection via Firestore rules + server-side serializers (NO Supabase migration now).
- **Resolution model:** platformOwner (Santiago) keeps full **local/offline** resolution + full DB visibility; ALL customer roles (businessOwner/admin/counter/viewer) resolve via a **protected server endpoint** that returns only product-facing data; customer browsers never download the alias/catalog/global DB. Offline customers queue their own scanned codes locally (raw code they personally scanned is OK; the full DB is not) and resolve on reconnect. Full alias/catalog/index download = platformOwner-only. Do NOT ship a sanitized full local index in the tire hotfix (optional later: limited per-business recent-resolve cache, TTL, no bulk export).

## NOW (tires-first hotfix — this branch)
1. Smart code normalization (`codeNormalizer.ts`) + safe matching (exact wins, normalized only if unambiguous, ambiguous -> Needs Review) + try no-dash/no-space variants in external/AI lookup.
2. Multi-code resolution + AI part-number enrichment (owner auto-create product with both codes; reliable scan-to-link of the 2nd code).
3. Human-mistake warning guard (`productMismatchGuard.ts`) — warn on category/brand mismatch (tire vs cigarette), explicit confirm + audit on override.
4. Repair the existing bad alias link (unlink/move alias + audit).

## DEFERRED (next foundation phase — add as TODOs)
- **platformOwner role** as a PLATFORM-level permission (NOT a business membership; NOT decided by client/localStorage). Options: `platform_admins` (strict rules + server-only writes), env allowlist for dev, or a secure custom claim.
- **Role model** enforcement: platformOwner (full internal DB) vs businessOwner/admin (operational, no raw-code DB export) vs counter/viewer (product-facing only).
- **Server-side customer resolution endpoint** (protected): customer scan -> server resolves against internal DB -> returns product-facing fields only (name, brand, part number, specs/description, category, qty/session, match status). No raw barcode/alias/UPC/EAN/GTIN/global-alias-id/source-evidence/provider/decode-trace.
- **Role-aware serializers**: `serializeProductForPlatformOwner|BusinessUser`, `serializeReviewFor*`, `serializeExportFor*`. Never return raw DB rows to customer clients.
- **Sensitive-field stripping** enforced in: UI components, CSV export builders, API responses, Firestore rules/server checks, client store serialization, reports/debug screens, logs, import/export flows, product lists, needs-review tables. (Field list in the plan amendment.)
- **Customer client-store rule**: customer roles must not receive/persist the internal barcode/alias DB in Zustand/localStorage/IndexedDB; offline = queue own scans, resolve on reconnect.
- **Alias scope**: `businessLocalAlias` (per-shop, not exported) vs `globalCatalogAlias` (platformOwner-owned, not downloadable by customers; shop contributions become candidates pending platformOwner validation).
- **Part-number-only CSV import + enrichment**: import as candidate/local product with `missing_barcode` status; register part number/SKU as businessLocalAlias; queue enrichment to find UPC/EAN/GTIN (saved as platformOwner-only internal alias); never mark barcode verified without evidence.
- **De-branding** customer-facing UI: provider/mechanics wording -> "Lookup"/"Decoding"/"Product search"/"Suggested product"/"Match confidence". Platform-owner diagnostics keep technical details.
- **Mismatch-guard role nuances**: businessOwner/admin warned (review/confirm in business-local scope); counter/viewer cannot override; platformOwner can override globally with confirm + audit. Audit events: alias_link_warning_shown, alias_link_override, alias_moved_or_unlinked, global_alias_candidate_created, global_alias_approved, global_alias_rejected.
- **Owner-only / sanitized exports**: code-bearing exports platformOwner-only; customer exports = product-facing only, stripped server-side.
