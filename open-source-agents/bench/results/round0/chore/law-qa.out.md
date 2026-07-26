<!-- subject=chore case=law-qa round=0 elapsed=172s rc=0 -->


**TL;DR:** Answers to 20 law-qa questions based on codebase and policies.

---

**Q1:** GDPR (General Data Protection Regulation) governs scanned codes and feed/count compliance.  
**Q2:** `ResolverService` in `src/services/resolver.ts` returns `known` if scan exists in DB or is a duplicate.  
**Q3:** No, AI/mock decode results are never auto-saved as aliases.  
**Q4:** `applyScanEventOnce` uses `idempotencyKey` on `InventoryCount` to prevent duplicates.  
**Q5:** Generated on first ScanEvent creation; not regenerated on retry.  
**Q6:** Real orchestrator: `decodeOrchestrator.ts`; deprecated: `oldDecoder.ts`.  
**Q7:** Free (basic), paid (premium), enterprise, custom (cost order).  
**Q8:** Decode ladder stops if current rung fails or exceeds budget limits.  
**Q9:** Gemini is deprecated; replaced by newer AI models in pipeline.  
**Q10:** Charges AI API calls; test/mock requests never charged against cap.  
**Q11:** Applied in `pipeline.ts` during request processing via middleware.  
**Q12:** `checkAndIncrementDaily` tracks daily usage; new code **must** call it.  
**Q13:** `markWrong` flags inventory as invalid but does **not delete** it.  
**Q14:** PostgreSQL (structured data) and MongoDB (unstructured logs).  
**Q15:** Tests must mock AI providers; enforced via environment variables in E2E tests.  
**Q16:** Tiers: `none`, `basic`, `medium`, `verified` (weakest to strongest).  
**Q17:** All decode steps succeed, evidence is sufficient, and no conflicts detected.  
**Q18:** Mask PII, internal IDs, API keys, and proprietary algorithms before sending.  
**Q19:** No, X00 codes are distinct from UPC/EAN/GTIN and cannot be treated as such.  
**Q20:** The `FeedFilter` gate suppresses invalid rows from feed/count.
