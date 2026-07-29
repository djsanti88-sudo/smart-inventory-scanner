# law-qa answers

1. TOP-LEVEL LAW: Every scanned code — known, unknown, misread, random, undecodable, or trust-gate-rejected — must immediately appear on the scan feed AND be counted in the session totals. Scan 10 codes = count 10, no exceptions. Decode/AI/firewalls/the barcode trust gate only decide the *identity* attached to a row (verified / suggested / unidentified); they never decide whether the row appears or counts. No gate, cap, breaker, or error may suppress a scanned row from the feed or count; an unidentifiable code still counts as an "Unidentified item" row.

2. `services/resolver.ts` decides "known." It returns `known` ONLY from (a) an APPROVED alias (`alias.approved === true`), or (b) a VERIFIED product identifier (`product.verified === true`). Everything else (including AI/mock suggestions) is not "known."

3. No. An AI/mock decode result is a suggestion only — it is never auto-saved as an alias.

4. `applyScanEventOnce` is the count-ledger function that applies a scan event to an `InventoryCount` exactly once. It uses `InventoryCount.scanEventIds` (the set/list of scan-event IDs already applied) to guarantee idempotency — each scan event is applied at most once regardless of retries.

5. An idempotency key is generated for a ScanEvent once, at scan time, and it is reused on every retry — it is never regenerated inside a retry.

6. The real decode orchestrator is `src/server/decode/pipeline.ts` (`runDecodePipeline`), fronted by `app/api/ai-lookup/route.ts`. The deprecated file that should NOT be extended is `services/ai/decodeOrchestrator.ts` (types only now).

7. Cost order, free to paid: L1 cache -> tire corpus -> retail corpus -> learned tier -> L2 Turso cache -> upcitemdb -> openfoodfacts (free stages), then a lazy daily-cap gate, then the paid rungs: `goupc` (GTIN-gated) -> `fetchv2` -> `gpt`.

8. The FIRST settled rung (verified OR suggestion) stops the ladder — it never pays for a later rung once an earlier one has answered.

9. Gemini is permanently out of decode. `GEMINI_DECODE_DISABLED = true` in pipeline.ts (grounding bills every executed search with no cap control). It survives only in legacy lookup / correction recheck, not in the decode ladder.

10. The daily AI cap (`AI_LOOKUP_DAILY_LIMIT`, default 2000) charges ONLY the paid rungs, exactly once per genuine compute. Free/corpus/cache hits never burn a slot.

11. It is applied inside the paid path via `chargeDailySlot`, after the free stages (cache/tire corpus/retail corpus/learned tier/L2 Turso cache/upcitemdb/openfoodfacts) have already run and missed, and after the lazy daily-cap gate — i.e., only when a genuinely paid rung is about to be charged, never charging two paths of one request.

12. `checkAndIncrementDaily` is the LEGACY lookup-mode gate. New code should NOT call it — new callers use the paid-path `chargeDailySlot` inside `pipeline.ts`.

13. No, it is not a delete. `markWrong` is a quantity TRANSFER: it repoints ScanEvents onto a fresh provisional record rather than deleting the counted quantity.

14. better-sqlite3 (local) stores the tire/retail knowledge corpus; Turso/libsql stores the decode cache and ladder usage data. They coexist on purpose as two separate DB layers.

15. Automated tests must NEVER call live AI providers. Unit tests mock the engines/fetch; E2E tests mock `/api/ai-lookup` via `page.route`, and the Playwright webServer sets `IS_E2E=1`, which forces the route to be mock-only.

16. From weakest to strongest: none < url_only < snippet < grounding_chunk < fetched_source. (`url_only` verifies only against a trusted-host allowlist.)

17. `decideDecode` returns "verified" only when: the code is a PUBLIC barcode shape (never X00/FNSKU/vendor/internal), there is strong app-verified evidence (single strong provider, or two providers agreeing), the identity is non-empty, and confidence is >= 0.8. Provider disagreement counts as conflict, not verified.

18. Before any AI call the deterministic sanitizer must mask: phone numbers, emails, obvious personal/customer/employee names, and cost/price/margin patterns. Only technical product fields are allowed to reach AI.

19. No. X00/Amazon FNSKU/ASIN codes and vendor-style labels (`detectCodeType` -> "vendor_label") are never treated as UPC/EAN/GTIN; they route to Needs Review unless a human-approved alias already exists for them.

20. Trap answer: none. No gate, cap, breaker, or firewall in this codebase is allowed to suppress a scanned row from appearing on the feed or from being counted — that is the TOP-LEVEL LAW (Q1). Every mechanism (decode ladder, trust gate, evidence verifier, daily cap, circuit breaker, prefix firewall) may only affect the *identity* assigned to a row, never its visibility or whether it counts.
