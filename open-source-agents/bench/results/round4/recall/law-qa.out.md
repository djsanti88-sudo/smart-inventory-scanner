<!-- subject=recall case=law-qa round=4 elapsed=47s rc=0 -->
**[recalled]**  
1. **TOP‑LEVEL LAW** – *“every scan appears and counts.”* Every scanned code (known, unknown, misread, random, undecodable, or trust‑rejected) must immediately appear on the scan feed and be counted. The system never suppresses a row from the feed or from being counted; only identity/decoding gates affect spending.

**[recalled]**  
2. In `src/services/resolver.ts` the function that decides “known” is **`resolveKnownAlias`** (or the logic inside it). It returns `known` **only** when:  
   * a) an alias has `alias.approved === true`, or  
   * b) the product has `product.verified === true`.  

No other condition can make it return `known`.

**[recalled]**  
3. No – AI/mock decode results are never auto‑saved as aliases. They are only suggestions and must be human‑approved before becoming an alias.

**[recalled]**  
4. **`applyScanEventOnce`** is the idempotency guard that records a scan event’s unique `id`. It uses the field **`InventoryCount.scanEventIds`** (a ledger of applied event IDs) to guarantee that re‑applying the same event is a no‑op.

**[recalled]**  
5. An idempotency key (`idempotencyKey`) for a ScanEvent is generated *once* at scan time, using the pattern `${businessId}:${sessionId}:${scanEventId}:${operation}`. It is **never regenerated on retry**; the same key is reused.

**[recalled]**  
6. The real decode orchestrator file is **`server/decode/pipeline.ts`** (or `runDecodePipeline`). The deprecated file that should not be extended is **`services/ai/lookup.ts`** (the legacy Gemini lookup path).

**[recalled]**  
7. Decode ladder rungs in cost order (free first, paid last):  
   1. L1 in‑memory cache  
   2. Tire corpus exact hit  
   3. Retail corpus (GTIN‑shaped)  
   4. Learned‑products tier (always “suggested”)  
   5. L2 Turso/libsql cache  
   6. Free half: `upcitemdb` → OpenFoodFacts  
   7. Lazy daily‑cap gate (between free/paid halves)  
   8. Paid half: Goupc (GTIN‑gated)  
   9. Fetchv2 (open‑web)  
   10. GPT  

**[recalled]**  
8. The ladder stops when the first rung that returns a settled result (`verified` or `suggested`) is reached; once settled, later rungs are not paid for and are never executed.

**[recalled]**  
9. Gemini is **permanently disabled** in the decode pipeline (`GEMINI_DECODE_DISABLED=true`). It only appears in legacy lookup mode and is not used for new AI calls.

**[recalled]**  
10. The daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charges **only paid rungs** (the paid half of the ladder). Free or corpus/cache hits never consume a slot; they are exempt from the cap.

**[recalled]**  
11. In `pipeline.ts` the cap charge is applied inside the paid path via `chargeDailySlot`, which is called by `services/security/aiSpendGuard.ts`. It occurs *after* the ladder has determined that a paid rung will run, but before any paid compute actually executes.

**[recalled]**  
12. **`checkAndIncrementDaily`** is the legacy file‑only gate for the lookup mode; it checks the daily counter and increments it. New code should call `chargeDailySlot` (via the security guard) instead of `checkAndIncrementDaily`.

**[recalled]**  
13. `markWrong` **deactivates bad aliases**, un‑verifies the product, and re‑points feed events onto a fresh “Unidentified item” provisional via `incrementInventoryCount`. It does **not delete** inventory quantity; total physical count remains invariant.

**[recalled]**  
14. Two data layers:  
   * **better‑sqlite3** – static knowledge corpus (tire/retail data, local `.db.gz`), used for exact lookups.  
   * **Turso/libsql** – decode cache and ladder usage/daily‑cap counters; stores ladder results and counts.

**[recalled]**  
15. Automated tests must **never call live providers**. In E2E tests this is enforced by setting `IS_E2E=1`, which forces `/api/ai-lookup` to route to the mock‑only path regardless of keys present.

**[inferred]**  
16. EvidenceVerifier strength tiers (weakest → strongest):  
   * none  
   * url_only  
   * snippet  
   * grounding_chunk  
   * fetched_source  

(Any additional tiers are not listed in the crib.)

**[recalled]**  
17. `decideDecode` returns “verified” only when all of the following hold:  
   * public barcode shape (never X00/FNSKU/vendor/internal)  
   * strong app‑verified evidence (single provider or two agreeing)  
   * non‑empty identity  
   * confidence ≥ 0.8  

**[recalled]**  
18. Before sending data to an AI provider, the deterministic sanitizer must mask: phones, emails, obvious names, and cost/price/margin patterns.

**[recalled]**  
19. X00/FNSKU/ASIN codes and vendor‑style labels are **never treated as UPC/EAN/GTIN**; they route to “Needs Review” unless a human‑approved alias exists.

**[recalled]**  
20. **No gate, cap, breaker, or firewall** in this codebase is allowed to suppress a scanned row from the feed or from being counted – the answer is **NONE**.
