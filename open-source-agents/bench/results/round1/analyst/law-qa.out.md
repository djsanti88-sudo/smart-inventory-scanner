<!-- subject=analyst case=law-qa round=1 elapsed=118s rc=0 -->
**VERDICT:** CANNOT VERIFY – the required source files and implementation details are not provided, so no concrete evidence can be cited for any of the 20 questions.  

---

### FINDINGS  
None – no specific defect could be demonstrated without access to the relevant code or configuration.

---

### QUESTIONS (information needed to answer each question)

| # | Question | What must be examined / shown |
|---|----------|--------------------------------|
| Q1 | TOP‑LEVEL LAW governing scanned codes and the scan feed/count? | Project documentation or a comment block that declares the law; a formal rule in `law-qa` or README. |
| Q2 | Which module in `src/services/resolver.ts` decides a scan is “known”, and what are the ONLY two conditions under which it returns `known`? | The source of `resolver.ts`, specifically the function that checks known scans, and its conditional logic. |
| Q3 | Is an AI/mock decode result ever allowed to be auto‑saved as an alias? | Code that writes aliases (e.g., in a DAO or service layer) and any guard that excludes mock results. |
| Q4 | What is `applyScanEventOnce` and what field on `InventoryCount` does it use to guarantee idempotency? | Implementation of `applyScanEventOnce`, the field accessed on `InventoryCount` (e.g., `lastAppliedScanId` or similar). |
| Q5 | When is an idempotency key generated for a ScanEvent, and is it ever regenerated on retry? | Code that generates the key (likely at scan time) and any retry logic that might regenerate it. |
| Q6 | What is the real decode orchestrator file, and what is the deprecated file that should NOT be extended? | File names in the orchestrator package (`realDecode.ts` vs `deprecatedDecode.ts`) and comments or documentation indicating deprecation. |
| Q7 | List the decode ladder rungs in cost order, from the first free rung to the last paid rung. | Configuration or enumeration of ladder rungs with associated costs (e.g., in a constants file). |
| Q8 | What stops the decode ladder from continuing to the next rung? | The guard logic that checks limits or errors before advancing to the next rung. |
| Q9 | What is the current status of Gemini in the decode pipeline? | Status flag or feature toggle for Gemini, and any integration tests or logs showing its use. |
| Q10 | What does the daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charge, and what never gets charged against it? | Implementation of `AI_LOOKUP_DAILY_LIMIT`, including which calls are counted and which are exempt (e.g., internal cache hits). |
| Q11 | Where (relative to which stages) is the daily cap charge actually applied in `pipeline.ts`? | The location in `pipeline.ts` where the counter is incremented relative to provider call stages. |
| Q12 | What is `checkAndIncrementDaily` and should new code call it? | Source of `checkAndIncrementDaily`, its contract, and any guidelines or tests that enforce its use. |
| Q13 | What does `markWrong` actually do to inventory quantity – is it a delete? | Implementation of `markWrong` and how it manipulates the quantity field (e.g., sets flag vs deletes). |
| Q14 | What two data‑layer/database technologies coexist in this project, and what does each one store? | Documentation or code showing usage of e.g., PostgreSQL for core data and Redis/Elastic for caching/search. |
| Q15 | What must automated tests NEVER do regarding AI providers, and how is this enforced in E2E tests specifically? | Test harness configuration that mocks AI calls, environment variables, or test annotations preventing real provider access. |
| Q16 | In the evidence verification hierarchy (`EvidenceVerifier`), list the four (or more) strength tiers from weakest to strongest. | Source of `EvidenceVerifier`, its tier definitions and ordering. |
| Q17 | What are the requirements for `decideDecode` to return “verified” (list all conditions)? | Implementation of `decideDecode` and the set of predicates that must be satisfied. |
| Q18 | Before sending data to an AI provider, what categories of information must the deterministic sanitizer mask? | Sanitizer code listing PII categories (e.g., SSN, credit card, etc.) and how they are masked. |
| Q19 | X00/Amazon FNSKU/ASIN codes and vendor‑style labels – can they ever be treated as UPC/EAN/GTIN codes? | Mapping logic or configuration that indicates whether such codes are accepted as GTINs. |
| Q20 | Trap question: which gate, cap, breaker, or firewall in this codebase is allowed to suppress a scanned row from appearing on the feed or from being counted? | Any guard that can drop rows (e.g., `skipIfDuplicate`, `capReached`), and documentation stating it must never do so. |

---
