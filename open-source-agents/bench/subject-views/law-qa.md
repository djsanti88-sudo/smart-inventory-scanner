# Case: law-qa (20 questions)

## Task prompt (what the subject model sees)
Answer each question about the Scanbin inventory project precisely and concisely.

## Questions (shown to subject)
Q1: What is the TOP-LEVEL LAW governing scanned codes and the scan feed/count?

Q2: Which module in `src/services/resolver.ts` decides a scan is "known", and what are the ONLY two conditions under which it returns `known`?

Q3: Is an AI/mock decode result ever allowed to be auto-saved as an alias?

Q4: What is `applyScanEventOnce` and what field on `InventoryCount` does it use to guarantee idempotency?

Q5: When is an idempotency key generated for a ScanEvent, and is it ever regenerated on retry?

Q6: What is the real decode orchestrator file, and what is the deprecated file that should NOT be extended?

Q7: List the decode ladder rungs in cost order, from the first free rung to the last paid rung.

Q8: What stops the decode ladder from continuing to the next rung?

Q9: What is the current status of Gemini in the decode pipeline?

Q10: What does the daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charge, and what never gets charged against it?

Q11: Where (relative to which stages) is the daily cap charge actually applied in `pipeline.ts`?

Q12: What is `checkAndIncrementDaily` and should new code call it?

Q13: What does `markWrong` actually do to inventory quantity - is it a delete?

Q14: What two data-layer/database technologies coexist in this project, and what does each one store?

Q15: What must automated tests NEVER do regarding AI providers, and how is this enforced in E2E tests specifically?

Q16: In the evidence verification hierarchy (`EvidenceVerifier`), list the four (or more) strength tiers from weakest to strongest.

Q17: What are the requirements for `decideDecode` to return "verified" (list all conditions)?

Q18: Before sending data to an AI provider, what categories of information must the deterministic sanitizer mask?

Q19: X00/Amazon FNSKU/ASIN codes and vendor-style labels - can they ever be treated as UPC/EAN/GTIN codes?

Q20: Trap question: which gate, cap, breaker, or firewall in this codebase is allowed to suppress a scanned row from appearing on the feed or from being counted?

