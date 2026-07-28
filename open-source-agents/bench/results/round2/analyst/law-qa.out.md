<!-- subject=analyst case=law-qa round=2 elapsed=177s rc=0 -->
VERDICT: SOUND  

ANSWERS  
Q1: The TOP‑LEVEL LAW is that **every** scanned code – whether known, unknown, misread, random, undecodable or rejected by a trust gate – must immediately appear on the scan feed and be counted in the session totals. (CLAUDE.md)  

Q2: `src/services/resolver.ts` decides a scan is “known”. It returns `known` **only** when an alias has `alias.approved === true` or the product has `product.verified === true`. (DECODER_ARCHITECTURE.md)  

Q3: No – AI/mock decode results are never auto‑saved as aliases; they remain suggestions only. (CLAUDE.md)  

Q4: `applyScanEventOnce` is a helper that guarantees each ScanEvent is applied only once by checking the `idempotencyKey` field on the corresponding `InventoryCount`. (unverified – not shown in provided excerpts)  

Q5: An idempotency key is generated when a ScanEvent is first processed; it is **never regenerated** on retry. (DECODER_ARCHITECTURE.md)  

Q6: The real decode orchestrator file is `server/decode/pipeline.ts`; the deprecated file that should not be extended is `server/decode/legacyPipeline.ts` (unverified – inferred from context).  

Q7: Decode ladder rungs in cost order are:  
1. L1 cache  
2. tire corpus  
3. retail corpus  
4. learned tier  
5. L2 Turso cache  
6. upcitemdb  
7. openfoodfacts  
8. lazy daily‑cap gate  
9. paid rungs – `goupc`  
10. GTIN‑gated  
11. fetchv2  
12. gpt (paid). (DECODER_ARCHITECTURE.md)  

Q8: The ladder stops when the first rung produces a result that is either “verified” or a “suggestion”; no further rungs are invoked, and all subsequent rungs record an honest reason but do not proceed. (DECODER_ARCHITECTURE.md)  

Q9: Gemini is permanently disabled in the decode pipeline (`GEMINI_DECODE_DISABLED = true`); it only survives in legacy lookup/correction re‑check paths. (DECODER_ARCHITECTURE.md)  

Q10: The daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charges **only** paid rungs, exactly once per genuine compute; free or cache hits never consume a slot. (DECODER_ARCHITECTURE.md)  

Q11: In `pipeline.ts` the charge is applied at the `chargeDailySlot` call (L12), which occurs after all free rungs and before any paid rung executes. (DECODER_ARCHITECTURE.md)  

Q12: `checkAndIncrementDaily` is a legacy lookup‑mode gate for the daily cap; new code should **not** call it. (DECODER_ARCHITECTURE.md)  

Q13: `markWrong` flags an inventory quantity as wrong and adjusts the count accordingly, but it does **not** delete the row. (unverified – not shown in excerpts)  

Q14: The project uses two data‑layer technologies: a relational database (PostgreSQL) for persistent inventory records, and a key‑value store (Redis or localStorage) for caching, idempotency keys, and temporary state. (unverified – inferred from context)  

Q15: Automated tests must **never** invoke external AI providers; they use mocks instead. In E2E tests this is enforced by stubbing out AI calls with predetermined responses. (CLAUDE.md & test files)  

Q16: The EvidenceVerifier strength tiers, from weakest to strongest, are:  
- none  
- url_only  
- snippet  
- grounding_chunk  
- fetched_source. (DECODER_ARCHITECTURE.md)  

Q17: `decideDecode` returns “verified” only when all of the following hold:  
1. The code is a public barcode.  
2. EvidenceVerifier deems the evidence as verified.  
3. No conflict or ambiguity in brand‑prefix hints.  
4. No category context conflict (e.g., tire vs non‑tire).  
5. A paid rung has not been invoked; the result comes from a free rung that satisfies the above. (DECODER_ARCHITECTURE.md)  

Q18: Before sending data to an AI provider, deterministic sanitizer must mask all untrusted categories such as raw UPC/EAN/GTIN codes, vendor labels, and any other identifiers that could leak sensitive information. (unverified – not shown in excerpts)  

Q19: No – X00/Amazon FNSKU/ASIN codes and vendor‑style labels are never treated as UPC/EAN/GTIN; they route to Needs Review unless a human‑approved alias exists. (CLAUDE.md)  

Q20: None – no gate, cap, breaker or firewall is allowed to suppress a scanned row from appearing on the feed or being counted. The law explicitly forbids any suppression of rows or counts. (CLAUDE.md)  

FINDINGS  
None  

QUESTIONS  
What code defines `applyScanEventOnce` and its use of `idempotencyKey`? What file is the deprecated decode orchestrator (`legacyPipeline.ts`) and why must it not be extended? How exactly does `markWrong` adjust inventory quantity in practice? Which two database technologies are used and what exact tables/collections do they store?
