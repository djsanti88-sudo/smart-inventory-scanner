<!-- subject=coder case=law-qa round=1 elapsed=31s rc=0 -->
NOTES:
- I cannot access the actual source files mentioned in the questions (e.g., `src/services/resolver.ts`, `pipeline.ts`)
- Without being able to examine the specific implementation, I can only provide general guidance based on the Doctrine principles
- Many of these questions require examining specific code implementations that are not provided
- For some questions, I'll need to make reasonable assumptions about typical patterns in such systems

Let me analyze what would be required for each question:

Q1: The TOP-LEVEL LAW governing scanned codes and scan feed/count would likely be defined by the core business logic of how inventory is tracked. Without seeing code, this cannot be determined precisely.

Q2: In `src/services/resolver.ts`, a module that decides if a scan is "known" would need to examine the actual implementation to identify which function returns `known` and under what exact conditions.

Q3: Whether AI/mock decode results can be auto-saved as aliases depends on specific logic in the codebase - this requires examining how alias saving is implemented.

Q4: `applyScanEventOnce` likely uses a field like `eventId` or similar to ensure idempotency, but without seeing the implementation details, I cannot specify which exact field.

Q5: The generation and regeneration of idempotency keys for ScanEvents would require examining how these are created in the codebase.

Q6: The real decode orchestrator file name and deprecated file that should not be extended would need to be identified from actual source files.

Q7-8: The decode ladder rungs, their cost order, and what stops progression through them requires seeing the implementation of this ladder system.

Q9: Current status of Gemini in the pipeline would require examining how AI providers are configured and used.

Q10-11: Daily AI cap behavior and where charges are applied needs to be seen in `pipeline.ts`.

Q12: The function `checkAndIncrementDaily` and whether new code should call it depends on its implementation details.

Q13: What `markWrong` does to inventory quantity requires examining the actual implementation of this method.

Q14-15: Data-layer/database technologies coexisting in the project, what each stores, and how AI provider restrictions are enforced would require seeing the database schema and test setup.

Q16-17: Evidence verification hierarchy strength tiers and requirements for `decideDecode` to return "verified" need specific code examination.

Q18: Deterministic sanitizer masking categories requires understanding what information is considered sensitive or deterministic in this context.

Q19: Whether X00/Amazon FNSKU/ASIN codes can be treated as UPC/EAN/GTIN codes depends on business logic rules that would require examining the actual implementation.

Q20: The trap question about gates, caps, breakers, or firewalls that suppress scanned rows requires identifying specific mechanisms in the codebase that filter out data.

Since I cannot execute or trace through any of these files, and no source code was provided for analysis, I must conclude:

I cannot answer these questions accurately without access to the actual implementation files. The Doctrine requires me to trace through concrete examples and verify claims with evidence from the code itself. Without being able to examine `src/services/resolver.ts`, `pipeline.ts`, or any other relevant files, I cannot provide accurate answers to these specific technical questions about this particular codebase.

If you can provide the source files mentioned in these questions (or at least their contents), I would be happy to analyze them following the Doctrine principles and answer each question precisely with evidence from the actual code.
