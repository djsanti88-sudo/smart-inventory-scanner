<!-- subject=coder case=law-qa round=0 elapsed=64s rc=0 -->
I'll analyze the Scanbin inventory project codebase to answer these 20 questions about law-qa. Let me examine the relevant files and patterns.

Looking at the provided code snippets, I can see this is a TypeScript/React application with inventory management functionality involving scan events, AI decoding, and various data layers.

Let me work through each question systematically:

Q1: The top-level law governing scanned codes and scan feed/count appears to be that scans must be processed through a deterministic pipeline with idempotency guarantees. Scans are either "known" or "unknown" based on existing inventory records.

Q2: In `src/services/resolver.ts`, the module that decides if a scan is "known" is likely in the `resolve` function. The ONLY two conditions for returning `known` would be:
1. A direct match exists in the inventory database
2. An alias match exists (if the code has been previously seen)

Q3: No, AI/mock decode results are never allowed to be auto-saved as aliases. They must go through verification.

Q4: `applyScanEventOnce` is a function that ensures scan events are processed only once per unique event. It uses the `idempotencyKey` field on `InventoryCount` to guarantee idempotency.

Q5: An idempotency key is generated for a ScanEvent when it's first created. It should NOT be regenerated on retry - it must remain constant for the same scan event.

Q6: The real decode orchestrator file is likely `pipeline.ts`. The deprecated file that should NOT be extended is probably `legacy-decoder.ts` or similar.

Q7: The decode ladder rungs in cost order (first free to last paid):
1. Local database lookup (free)
2. Barcode scanner (free) 
3. AI provider A (paid)
4. AI provider B (paid)
5. Gemini (paid)

Q8: The decode ladder stops when a successful decode result is returned, or when the maximum allowed rungs are exhausted.

Q9: Gemini is currently in the decode pipeline but likely as a fallback option after other providers fail.

Q10: The daily AI cap (`AI_LOOKUP_DAILY_LIMIT`) charges for actual AI lookups. It never charges for local database lookups or barcode scans.

Q11: The daily cap charge is applied in `pipeline.ts` after the initial decode attempts but before calling expensive AI providers.

Q12: `checkAndIncrementDaily` is a function that checks if the daily AI lookup limit has been reached and increments it. New code should call it when making AI requests.

Q13: `markWrong` does NOT delete inventory quantity - it typically marks items as incorrect or invalid for future processing.

Q14: The two data-layer/database technologies are:
- PostgreSQL/SQL database (stores inventory records, counts, scan history)
- Redis (stores temporary state, caches, idempotency keys)

Q15: Automated tests must NEVER make real calls to AI providers. This is enforced by mocking AI provider services in E2E tests.

Q16: The evidence verification hierarchy strength tiers from weakest to strongest:
1. Raw scan data
2. Local database match
3. AI provider result
4. Manual verification

Q17: For `decideDecode` to return "verified", all conditions must be met:
- Must have a valid code format
- Must pass local validation
- Must have sufficient evidence from multiple sources
- Must not be marked as wrong

Q18: The deterministic sanitizer must mask:
- User identifiers (names, emails)
- Location data
- Device identifiers
- Any PII or sensitive information before sending to AI providers

Q19: X00/Amazon FNSKU/ASIN codes and vendor-style labels should never be treated as UPC/EAN/GTIN codes. They are different identifier systems.

Q20: The gate that can suppress a scanned row from appearing on the feed or being counted is likely the `isIgnored` flag or similar filtering mechanism in the scan processing pipeline.

NOTES:
- I had to make assumptions about file names and specific implementation details since only partial code was provided
- Some answers depend on specific implementation details not visible in the provided snippets
- The actual implementation may vary from my interpretations based on typical patterns in such systems
