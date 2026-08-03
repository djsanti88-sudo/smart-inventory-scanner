# Boss Shop-Code Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the ten boss-provided non-GTIN shop codes that have approved, collision-free leading-zero mappings to canonical tire barcodes, while preserving exact-match precedence and rejecting every unlisted near match.

**Architecture:** Add a frozen server-only evidence ledger mapping each approved raw shop code to a canonical barcode and identity fingerprint. The tire index may consult it only for an authenticated business explicitly allowlisted by server configuration; normal exact GTIN lookup stays first, every target fingerprint is revalidated, and alias results never enter shared caches, the master catalog, or the global outcome ledger. Retail remains indexed equality/`IN`; no substring/`CONTAINS` lookup is introduced.

**Tech Stack:** TypeScript, Vitest, better-sqlite3/Turso lookup adapters, Next.js server-only modules.

## Global Constraints

- Every physical scan still appears and counts; this change affects identity resolution only.
- Wrong identity is worse than unknown: no generic ten-digit padding, suffix, prefix, substring, fuzzy, part-number, or `LIMIT 1` guess is permitted.
- Existing exact barcode/GTIN lookup always wins before an alias redirect.
- Redirects are accepted only when the loaded canonical row matches the frozen UID, barcode, manufacturer part number, normalized brand, and normalized tire size.
- The returned product keeps its canonical barcode; the scanned shop code is evidence, not a replacement barcode.
- A boss shop-code redirect requires an authenticated `businessId` contained in server-only `BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS`; anonymous and other-tenant requests must miss.
- Alias results must not be persisted to shared L1/L2 decode caches, the master catalog, learned products, or the global outcome ledger.
- Do not mutate live Turso/Firebase, call paid providers, deploy, push, or run E2E.

---

### Task 1: Frozen boss shop-code evidence ledger

**Files:**
- Modify: `src/server/tire-knowledge/bossExactEvidenceLedger.ts`
- Modify: `src/server/tire-knowledge/bossExactEvidenceLedger.test.ts`

**Interfaces:**
- Produces: `BossShopCodeRedirect`, `BOSS_SHOP_CODE_REDIRECTS`, `findBossShopCodeRedirect(scannedCode)`, and `matchesBossShopCodeRedirectTarget(redirect, row)`.
- The map contains exactly these approved raw-to-canonical pairs and their evidence fingerprints from `BOSS_ROW_RECONCILIATION.csv`: `3220017209 -> 003220017209`, `3220017315 -> 003220017315`, `3220017438 -> 003220017438`, `3220017483 -> 003220017483`, `3220018367 -> 003220018367`, `3220018381 -> 003220018381`, `3220018411 -> 003220018411`, `3220018428 -> 003220018428`, `3220018435 -> 003220018435`, `77676020526 -> 077676020526`.

- [ ] **Step 1: Write failing tests**

Add table-driven assertions that the ten exact raw keys return the expected canonical barcode/UID, the ledger contains ten unique keys and unique key-to-UID decisions, an unlisted neighbor such as `3220017210` returns `undefined`, and target validation rejects a changed UID, barcode, MPN, brand, or size.

- [ ] **Step 2: Verify RED**

Run: `.\\node_modules\\.bin\\vitest.cmd run src/server/tire-knowledge/bossExactEvidenceLedger.test.ts`

Expected: FAIL because the redirect interfaces do not exist.

- [ ] **Step 3: Implement the immutable ledger**

Add the ten entries with `workbookSha256`, `sourceSheet`, `sourceRow`, `canonicalBarcode`, `canonicalProductUid`, `canonicalManufacturerPartNumber`, `normalizedBrand`, `canonicalSize`, and `disposition: "accepted"`. Build an exact normalized-key map that throws on duplicate keys with conflicting UIDs. `findBossShopCodeRedirect` may remove scanner spaces/dashes only; it must not pad, strip zeros, or substring-match.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 test command and focused ESLint for the two files.

- [ ] **Step 5: Commit explicit paths**

Commit only the two Task 1 files with message `feat(tires): add approved boss shop-code ledger`.

### Task 2: Fail-closed runtime redirect across all corpus backends

**Files:**
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts`
- Create: `src/server/tire-knowledge/tireKnowledgeIndex.bossShopCodeAlias.test.ts`
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.ts`
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.test.ts`
- Modify: `src/server/decode/pipeline.ts`
- Modify: `src/server/decode/pipeline.test.ts`
- Modify: `src/app/api/ai-lookup/route.ts`
- Modify: `src/app/api/ai-lookup/route.d4.test.ts`
- Modify: `src/app/api/ai-lookup/route.masterAppend.test.ts`

**Interfaces:**
- Consumes: Task 1 ledger lookup and fingerprint validator.
- Produces: tenant-gated exact canonical row lookup after a normal barcode miss, with an internal marker; pipeline/route integration suppresses every shared persistence side effect.

- [ ] **Step 1: Write failing index/provider tests**

Add tests proving a representative alias resolves to its canonical row, all ten ledger aliases are recognized by the redirect contract, an unlisted neighbor remains `null`, exact canonical lookup has precedence, a missing or mismatched target returns `null`, the provider decision is verified with evidence matched to the scanned alias, and `primaryBarcode` remains the canonical barcode.

- [ ] **Step 2: Verify RED**

Run the two focused test files and confirm the expected alias miss/failure.

- [ ] **Step 3: Implement minimal backend redirect**

For SQLite, Turso, and JSON, perform the existing candidate lookups first. Only when the request carries an authenticated business ID present in `BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS`, look up the exact ledger key, fetch its canonical barcode/UID using indexed equality, validate the full identity fingerprint, then return the canonical row plus the internal marker. Backend errors, missing targets, multiple distinct UID owners, fingerprint disagreement, absent auth, and non-allowlisted businesses return `null`. Update provider evidence/reason text to distinguish an approved shop-code alias while retaining the canonical product barcode. Thread the authenticated business from the route through the pipeline, skip global outcome append for alias hits, and prevent the route from appending the scanned alias to the master catalog.

- [ ] **Step 4: Verify GREEN and regression gates**

Run:

`.\\node_modules\\.bin\\vitest.cmd run src/server/tire-knowledge/bossExactEvidenceLedger.test.ts src/server/tire-knowledge/tireKnowledgeIndex.bossShopCodeAlias.test.ts src/server/tire-knowledge/tireKnowledgeIndex.variants.test.ts src/server/tire-knowledge/TireKnowledgeProvider.test.ts src/services/upc/gtin.test.ts src/server/retail-knowledge/retailKnowledgeIndex.test.ts src/server/decode/pipeline.test.ts src/app/api/ai-lookup/route.test.ts`

Then run focused ESLint on every changed production/test file. Do not run E2E.

- [ ] **Step 5: Commit explicit paths**

Commit only the Task 2 production/test paths with message `fix(decode): resolve approved boss barcode aliases`.

### Task 3: Final evidence and adversarial review

**Files:**
- No production files unless the reviewer confirms a Critical or Important defect.

**Interfaces:**
- Consumes: complete Task 1–2 diff and test output.
- Produces: review verdict covering collision safety, canonical-barcode preservation, backend parity, tenant/identity risk, and retail performance.

- [ ] **Step 1: Run a ten-code offline replay**

Use only local/mock corpus adapters. Assert all ten expected canonical UIDs, zero wrong identities, zero paid/network calls, and rejection of unlisted and near-match codes. The remaining boss codes are outside this approved leading-zero alias set and must remain unresolved unless separately proven.

- [ ] **Step 2: Run final lower-tier adversarial review**

Review the full branch diff. Any confirmed Critical or Important issue gets one focused subagent fix wave and one re-review.

- [ ] **Step 3: Fresh final verification**

Re-run all focused tests and ESLint from Task 2, inspect `git diff --check`, and confirm the branch contains no unrelated staged paths. Do not push, deploy, mutate Turso, or run E2E.
