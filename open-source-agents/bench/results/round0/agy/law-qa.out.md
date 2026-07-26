# Q&A: law-qa

**Q1: What is the TOP-LEVEL LAW governing scanned codes and the scan feed/count?**  
**A1:** Every physical barcode scan MUST create a scan feed event row and contribute to session counted quantities (every scan is recorded; no scan is ever silently dropped, filtered, or suppressed by any gate or breaker).

---

**Q2: Which module in `src/services/resolver.ts` decides a scan is "known", and what are the ONLY two conditions under which it returns `known`?**  
**A2:** `matchProductByIdentifiers` in `src/services/resolver.ts`. The ONLY two conditions under which it returns `known` are:
1. Matching a verified product (`verified === true`) by its primary barcode identifier.
2. Matching an approved alias (`approved === true`) linked to a verified product.

---

**Q3: Is an AI/mock decode result ever allowed to be auto-saved as an alias?**  
**A3:** No. AI or mock decode results are NEVER allowed to be auto-saved as approved aliases without explicit human verification and approval.

---

**Q4: What is `applyScanEventOnce` and what field on `InventoryCount` does it use to guarantee idempotency?**  
**A4:** `applyScanEventOnce` is the state update function that applies a scan event's quantity delta to an `InventoryCount` exactly once. It uses the `scanEventIds` (or `appliedEventIds`) array field on `InventoryCount` to track applied event IDs and guarantee idempotency.

---

**Q5: When is an idempotency key generated for a ScanEvent, and is it ever regenerated on retry?**  
**A5:** An idempotency key is generated when the `ScanEvent` is first created at scan time in the client. It is NEVER regenerated on retry (the key persists across all sync retries to prevent duplicate processing).

---

**Q6: What is the real decode orchestrator file, and what is the deprecated file that should NOT be extended?**  
**A6:**
- Real decode orchestrator file: `src/server/decode/pipeline.ts`
- Deprecated file: `src/services/aiDecode.ts`

---

**Q7: List the decode ladder rungs in cost order, from the first free rung to the last paid rung.**  
**A7:**
1. Free local retail DB lookup / Open Food Facts peek (Turso / SQLite)
2. Free API / Grounding rungs (UPCitemdb / Open Food Facts / Grounding)
3. Plan D (Grounding / Firecrawl)
4. Go-UPC (Paid API)
5. Fetch V2 (Paid web search API)
6. GPT-5.5 / LLM (Paid AI model)

---

**Q8: What stops the decode ladder from continuing to the next rung?**  
**A8:** A rung returning a settled result with a verified/high-confidence payload (`win`), or reaching the daily AI cap / circuit breaker threshold.

---

**Q9: What is the current status of Gemini in the decode pipeline?**  
**A9:** Gemini is cost-guarded and asynchronous/non-blocking for secondary correction rechecks only; it does NOT auto-save or execute synchronously in the primary blocking scan decode ladder.

---

**Q10: What does the daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charge, and what never gets charged against it?**  
**A10:** It charges paid external AI/LLM lookup requests (such as GPT or paid web scrapers). Free local database hits, cached results, deterministic resolver matches, and local alias lookups never get charged against it.

---

**Q11: Where (relative to which stages) is the daily cap charge actually applied in `pipeline.ts`?**  
**A11:** The daily cap charge is applied after evaluating the free ladder / Plan D rungs and immediately before executing paid ladder rungs.

---

**Q12: What is `checkAndIncrementDaily` and should new code call it?**  
**A12:** `checkAndIncrementDaily` is a legacy rate-limiting/cap-tracking function. New code should NOT call it (cap management is handled centrally within `pipeline.ts`).

---

**Q13: What does `markWrong` actually do to inventory quantity - is it a delete?**  
**A13:** `markWrong` un-links the incorrect product match, deactivates bad aliases, unverifies the product, resets feed entries to `needs_review`, and adjusts/removes the count line. It is an un-linking and re-queuing operation for audit and re-identification, NOT a permanent deletion of scan feed history or product entities.

---

**Q14: What two data-layer/database technologies coexist in this project, and what does each one store?**  
**A14:**
1. **SQLite / Turso**: Stores the free, local 4M+ row retail product knowledge index (Open Food Facts).
2. **Firestore / Firebase**: Stores multi-tenant operational application state (products, aliases, sessions, inventory counts, scan feed, review queues, and sync items).

---

**Q15: What must automated tests NEVER do regarding AI providers, and how is this enforced in E2E tests specifically?**  
**A15:** Automated tests must NEVER call live paid AI provider APIs. In E2E tests specifically, this is enforced by setting `e2eMode()`, intercepting network calls, and short-circuiting external paid rungs.

---

**Q16: In the evidence verification hierarchy (`EvidenceVerifier`), list the four (or more) strength tiers from weakest to strongest.**  
**A16:**
1. Un-grounded AI/LLM speculation (Weakest)
2. Web search / unstructured snippet matches
3. Structured retail database match (Open Food Facts / UPCitemdb)
4. Explicit human owner approval / direct verification (Strongest)

---

**Q17: What are the requirements for `decideDecode` to return "verified" (list all conditions)?**  
**A17:**
1. Valid, clean barcode (UPC/EAN/GTIN).
2. Grounded evidence meeting consensus thresholds (e.g., multi-source agreement or direct owner verification).
3. Complete primary product attributes (product name, brand/category).
4. Confidence score meeting verification criteria with no unresolved blocking flags.

---

**Q18: Before sending data to an AI provider, what categories of information must the deterministic sanitizer mask?**  
**A18:** Tenant PII (user IDs, business IDs, custom pricing, location data, internal notes, system diagnostics, and private shop configurations).

---

**Q19: X00/Amazon FNSKU/ASIN codes and vendor-style labels - can they ever be treated as UPC/EAN/GTIN codes?**  
**A19:** No. Internal vendor codes, Amazon FNSKU/ASINs, and X00 codes are proprietary/local identifiers, NOT global GTIN standard barcodes, and must never be treated or resolved as global public GTINs.

---

**Q20: Trap question: which gate, cap, breaker, or firewall in this codebase is allowed to suppress a scanned row from appearing on the feed or from being counted?**  
**A20:** NONE. No gate, cap, circuit breaker, or firewall in this codebase is EVER allowed to suppress a scanned row from appearing on the scan feed or from being counted. Every physical scan must create a scan event and contribute to session counts.
