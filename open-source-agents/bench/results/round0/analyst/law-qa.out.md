<!-- subject=analyst case=law-qa round=0 elapsed=81s rc=0 -->
**VERDICT:** CANNOT VERIFY – the provided information does not contain any source code or concrete excerpts that can be examined to confirm or refute the specific behaviors and implementation details requested in the questions.

---

### FINDINGS
No concrete findings could be produced because no relevant code lines, logs, or configuration snippets were supplied.  Without such evidence, it is impossible to identify race‑condition risks, security exposures, failure modes, scope violations, or counterexamples that would refute the claims made by the project’s design.

---

### QUESTIONS (What I’d need to see in order to answer each question)

| # | Question | What I’d need to examine |
|---|----------|---------------------------|
| 1 | TOP‑LEVEL LAW governing scanned codes and the scan feed/count? | Project documentation or a comment block that declares the law, or a unit test asserting it. |
| 2 | Which module in `src/services/resolver.ts` decides a scan is “known”, and what are the ONLY two conditions under which it returns `known`? | The source file `resolver.ts`, specifically the function that returns `known`. |
| 3 | Is an AI/mock decode result ever allowed to be auto‑saved as an alias? | Code paths where AI results are persisted, and any guard clauses preventing alias creation. |
| 4 | What is `applyScanEventOnce` and what field on `InventoryCount` does it use to guarantee idempotency? | The implementation of `applyScanEventOnce`, plus the definition of `InventoryCount`. |
| 5 | When is an idempotency key generated for a ScanEvent, and is it ever regenerated on retry? | Logic that creates the key (e.g., timestamp + scan ID) and any retry handling code. |
| 6 | What is the real decode orchestrator file, and what is the deprecated file that should NOT be extended? | File names and import statements in the pipeline. |
| 7 | List the decode ladder rungs in cost order, from the first free rung to the last paid rung. | Configuration or constants defining rung costs. |
| 8 | What stops the decode ladder from continuing to the next rung? | Conditional checks or exception handling that halts progression. |
| 9 | What is the current status of Gemini in the decode pipeline? | Documentation or code comments indicating Gemini’s role (enabled/disabled). |
|10 | What does the daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charge, and what never gets charged against it? | The function that decrements the limit and its list of exempted actions. |
|11 | Where (relative to which stages) is the daily cap charge actually applied in `pipeline.ts`? | The exact line(s) where the cap is checked or updated. |
|12 | What is `checkAndIncrementDaily` and should new code call it? | Implementation of `checkAndIncrementDaily` and any guidelines on its usage. |
|13 | What does `markWrong` actually do to inventory quantity – is it a delete? | The body of `markWrong` and how it manipulates the quantity field. |
|14 | What two data‑layer/database technologies coexist in this project, and what does each one store? | Configuration files or code that initialize both database clients (e.g., Prisma + DynamoDB). |
|15 | What must automated tests NEVER do regarding AI providers, and how is this enforced in E2E tests specifically? | Test setup/teardown logic that mocks or blocks real provider calls. |
|16 | In the evidence verification hierarchy (`EvidenceVerifier`), list the four (or more) strength tiers from weakest to strongest. | The enum or constant definitions inside `EvidenceVerifier`. |
|17 | What are the requirements for `decideDecode` to return “verified” (list all conditions)? | The conditional logic inside `decideDecode`. |
|18 | Before sending data to an AI provider, what categories of information must the deterministic sanitizer mask? | Sanitizer implementation and its whitelist/blacklist. |
|19 | X00/Amazon FNSKU/ASIN codes and vendor‑style labels – can they ever be treated as UPC/EAN/GTIN codes? | Mapping rules or validation functions that convert these identifiers. |
|20 | Trap question: which gate, cap, breaker, or firewall in this codebase is allowed to suppress a scanned row from appearing on the feed or from being counted? | The specific guard clauses or early‑return statements in the scan pipeline. |

---
