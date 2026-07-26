<!-- subject=analyst case=hprocess-01 round=0 elapsed=156s rc=0 -->
**TRACE:**  
*Scenario 1 – TTL expiry logic (conceptual)*  
- Input: barcode `"1234567890123"` inserted at time `T0`.  
- Code computes `expiry = T0 + DECODE_CACHE_TTL_MS` (30 days).  
- After 29 days (`T0+29d`) a cache lookup returns the stored value because current time < expiry.  
- After 31 days (`T0+31d`) a cache lookup returns `null` because current time > expiry.  

*Scenario 2 – key‑normalization consistency (conceptual)*  
- Existing entry stored with old format `"123‑456"` before change.  
- New code normalizes the same string to `"123‑456"`. If the old format differed (e.g., `"123-456"`), a lookup would fail because the normalized key no longer matches the stored key.

**SYNTAX-FILTER:** No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.  

**VERDICT:** FLAWED – insufficient test coverage and potential side‑effects.  

**FINDINGS:**  
1. **[CRITICAL] [Correctness & data integrity]** *Potential double counting from warm script*  
   - Starting state: cache empty.  
   - Action: run `scripts/cache-warm.mjs` on 40 barcodes, each invoking the real decode pipeline.  
   - Wrong outcome: counts increased by 40 before any actual scan session.  
   - Expected outcome: no count change until the barcodes are scanned in the normal workflow.  
   - Evidence line: “Added a new script, `scripts/cache-warm.mjs`, that reads a list of barcodes from a JSON file and calls the real decode pipeline for each one…”

2. **[MAJOR] [Correctness & data integrity]** *Key‑normalization unification may break existing cache entries*  
   - Starting state: cache contains key `"123-456"` stored with old format.  
   - Action: unify to new `normalizeCacheKey()` helper.  
   - Wrong outcome: `getCache` fails to find the entry because the normalized key no longer matches the stored key.  
   - Expected outcome: cached value still retrievable after change.  
   - Evidence line: “unified both to use the same `normalizeCacheKey()` helper”

3. **[MAJOR] [Security & tenancy]** *Debug console.log leaks raw API responses*  
   - Starting state: script executed with real `GO_UPC_API_KEY` and `OPENAI_API_KEY`.  
   - Action: log each barcode and the raw API response body.  
   - Wrong outcome: sensitive data (e.g., secrets, personal info) could be exposed in logs or to users with access.  
   - Expected outcome: no production logs containing raw responses.  
   - Evidence line: “added a `console.log` in `cache-warm.mjs` that prints each barcode alongside the raw API response body for debugging”

4. **[MINOR] [Failure modes & honesty]** *Only targeted test file run, not full suite*  
   - Starting state: change touches only one file plus a new script.  
   - Action: `npx vitest run src/server/decodeCacheStore.test.ts`.  
   - Wrong outcome: regressions in other modules remain untested; risk of hidden failures.  
   - Expected outcome: all tests (including unrelated modules) pass, ensuring no side‑effects.  
   - Evidence line: “Did not run the full suite since this change is isolated to one file plus a new standalone script”

5. **[MINOR] [Simplicity & scope]** *Documentation not updated for TTL change*  
   - Starting state: users expect 7‑day TTL.  
   - Action: changed default to 30 days.  
   - Wrong outcome: user confusion, misaligned expectations.  
   - Expected outcome: release notes or documentation reflect new TTL value.  
   - Evidence line: “Bumped `DECODE_CACHE_TTL_MS` handling so entries default to a 30‑day TTL instead of 7”

6. **[MINOR] [Correctness & data integrity]** *Warm script uses real API keys, risking rate limits or cost*  
   - Starting state: environment has `GO_UPC_API_KEY`, `OPENAI_API_KEY`.  
   - Action: run warm script once on 40 barcodes.  
   - Wrong outcome: potential throttling, billing, or side‑effects in production.  
   - Expected outcome: use mocks or safe test environment.  
   - Evidence line: “Ran it once against our actual `GO_UPC_API_KEY` and `OPENAI_API_KEY`”

7. **[MINOR] [Correctness & data integrity]** *No concurrency tests for cache writes*  
   - Starting state: multiple processes may write to the same persistent cache.  
   - Action: none (no test).  
   - Wrong outcome: race conditions could lead to stale or missing entries.  
   - Expected outcome: thread‑safe behavior verified by concurrent tests.  
   - Evidence line: “unified both to use the same `normalizeCacheKey()` helper” (implies potential concurrency issues)

**QUESTIONS:**  
- What is the exact code path that calculates TTL in `deocodeCacheStore.ts`? Need to confirm default 30‑day value is applied everywhere.  
- Does calling the decode pipeline from the warm script auto‑count decodes, or does it only populate cache? Need to verify side‑effects on counts.  
- Are there any hardcoded 7‑day TTL values elsewhere that might override the new constant?  
- How does the system handle concurrent writes to the persistent cache? Need thread‑safety tests.
