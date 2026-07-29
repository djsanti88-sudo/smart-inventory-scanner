# Scanbin law Q&A

**Q1.** Every physical scan must produce one durable scan-feed event and apply its quantity exactly once. Resolution, enrichment, caps, failures, and retries may change the row's status, but may not suppress the row or lose/duplicate its count.

**Q2.** The deterministic resolver in `src/services/resolver.ts`—the approved-alias lookup plus `matchProductByIdentifiers`—is the authority for `"known"`. It may return known only for (1) an exact approved alias mapping, or (2) an exact identifier match to an existing product whose `verified` flag is `true`.

**Q3.** No. AI and mock decode output is suggestion/evidence only. It must go through review and human approval before becoming an alias.

**Q4.** `applyScanEventOnce` is the idempotent count-ledger reducer: it applies a scan event's quantity delta only if that event has not already been applied. It records/checks `InventoryCount.scanEventIds`.

**Q5.** The idempotency key is generated once when the `ScanEvent` is first created/enqueued. The same persisted key is reused for every retry; retry must never regenerate it.

**Q6.** The real orchestrator is `src/server/decode/pipeline.ts`. `src/services/ai/decode.ts` is the deprecated compatibility/legacy path and must not be extended.

**Q7.** The cost order is: local/Open Food Facts retail peek and the free UPCitemdb/OFF evidence rung, then the Plan D grounding/floor stage, then the cap gate, followed by the paid ladder `Go-UPC -> Fetch V2 -> GPT-5.5`. Strictly, the retail peek and Plan D are surrounding stages; the paid ladder proper is the final three rungs.

**Q8.** Only a settled rung with an acceptable verified decision stops escalation. A miss, error, timeout, conflict, or merely suggested/unverified identity falls through to the next rung.

**Q9.** Gemini is not a normal auto-resolution rung. It is confined to the stronger, cost-guarded correction/recheck path and may produce review evidence only; it may not auto-save an alias or count.

**Q10.** The cap charges a request only when it actually escalates into the paid AI lookup path. Deterministic known matches, cache hits, local/free retail lookups, feed creation, counting, mocks/tests, and requests resolved before the paid gate are never charged.

**Q11.** The charge is applied after cache/retail/free-ladder work and after the Plan D pre-paid stage, immediately before entering the paid ladder. It must not be charged at scan capture or before free resolution opportunities run.

**Q12.** `checkAndIncrementDaily` is the legacy low-level check-and-mutate helper for the daily counter. New code should not call it; cap accounting belongs in the centralized pipeline gate so ordering and concurrency semantics cannot be bypassed.

**Q13.** `markWrong` is a reassignment/correction, not a quantity delete. It must unlink the bad identity and preserve the affected units under an unresolved/provisional review identity (while leaving unrelated valid quantity intact).

**Q14.** Firestore stores tenant operational data such as businesses, products, aliases, sessions, counts, and sync records. SQLite locally and Turso remotely store the shared, read-oriented retail barcode knowledge corpus.

**Q15.** Automated tests must never contact or spend money on real AI/provider services. Provider boundaries must be mocked. E2E runs additionally enable the explicit E2E-mode guard, which routes decode through deterministic fixtures/mocks and prevents the live provider pipeline from running.

**Q16.** From weakest to strongest: `none/unverified`; weak self-assertion or unsupported AI output; moderate evidence from one structured/secondary source; strong code-specific grounded evidence or independent-source agreement; authoritative primary evidence such as a manufacturer/registry source.

**Q17.** `decideDecode` may return `"verified"` only when all of these hold: there is a usable, non-placeholder product identity; the evidence is specifically tied to the normalized scanned code; the required evidence-strength/independent-consensus threshold is met; sources agree on the identity; confidence meets the verified threshold; and there are no conflicts or blocking reasons. A provider's own `"verified"` flag is not one of those proofs and cannot substitute for them.

**Q18.** The deterministic pre-provider sanitizer must mask secrets/credentials; personal identifiers and contact data; tenant, user, session, and other internal IDs; business/store and precise location data; inventory-sensitive quantities, costs, prices, and margins; and unrelated free-text notes or internal diagnostics. Only the minimum code/product context needed for the lookup should be sent.

**Q19.** No. X00 codes, Amazon FNSKU/ASIN values, and vendor labels stay vendor identifiers. They must never be padded, digit-extracted, or otherwise coerced into UPC-A, EAN-13, or GTIN-14, even when their characters superficially resemble one.

**Q20.** None. A cache, auth gate, AI cap, circuit breaker, provider failure, resolver firewall, or decode status may stop enrichment or verification, but no such mechanism may suppress the scan-feed row or its exactly-once count application.
