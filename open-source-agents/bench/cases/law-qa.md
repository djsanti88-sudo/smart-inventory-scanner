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

## GROUND TRUTH (never shown to subject)
A1: "Every Scan Appears and Counts" - EVERY scanned code (known, unknown, misread, random, undecodable, trust-gate-rejected) must immediately appear on the scan feed AND be counted in session totals. Decode/AI/firewalls/trust gate only decide IDENTITY, never visibility or counting. Source: CLAUDE.md "TOP-LEVEL LAW" section; also LESSONS_LEARNED-adjacent "every-scan-appears-and-counts" law (owner order 2026-07-15).

A2: `src/services/resolver.ts`. Returns `known` ONLY from (1) an APPROVED alias (`alias.approved === true`) or (2) a VERIFIED product identifier (`product.verified === true`). Source: CLAUDE.md "Resolver Trust Rules".

A3: No. AI/mock results are SUGGESTIONS only - never auto-saved as aliases, never mark a scan Known; they are only counted through the documented auto-count gate. Source: CLAUDE.md "Resolver Trust Rules".

A4: `applyScanEventOnce` is the count-ledger function in `services/inventory.ts` that applies a ScanEvent's quantityDelta exactly once. It uses `InventoryCount.scanEventIds[]` as the dedupe set - an event id already present in that array is never re-applied (a no-op on retry). Source: CLAUDE.md "Architecture at a Glance" / docs/ARCHITECTURE.md section 2 step 4 and section 5.

A5: Generated ONCE at scan time and reused on every retry; it is never regenerated inside a retry (that would defeat dedupe and double-count). Source: CLAUDE.md "Optimistic State, Offline, Idempotent Sync"; DECISIONS.md "IDs and idempotency".

A6: Real orchestrator: `src/server/decode/pipeline.ts` (`runDecodePipeline`), fronted by `app/api/ai-lookup/route.ts`. Deprecated: `src/services/ai/decodeOrchestrator.ts` (types only, no live runtime callers). Source: CLAUDE.md "Architecture at a Glance"; docs/ARCHITECTURE.md Trap #1.

A7: (1) L1 in-memory cache, (2) tire corpus exact hit, (3) retail corpus (GTIN-shaped only), (4) learned-products tier (always suggested), (5) L2 persistent Turso cache, (6) free ladder half: upcitemdb -> openfoodfacts, [lazy daily-cap gate sits here], (7) paid ladder half: goupc (GTIN-gated) -> fetchv2 -> gpt. Source: docs/ARCHITECTURE.md section 3 table; CLAUDE.md "Decode Ladder + Evidence Rules".

A8: The FIRST settled rung (verified OR suggestion) stops the ladder - never pay for a rung when an earlier one already answered. Each rung returns `{settled, payload?, reason}`. Source: CLAUDE.md "LADDER BASELINE v2"; docs/ARCHITECTURE.md section 3.

A9: Gemini is PERMANENTLY OUT of decode (`GEMINI_DECODE_DISABLED = true`) - grounding bills every executed search query with no cap control (L11). It survives only in legacy `lookup` mode and the correction re-check; status responses report `geminiUsedForDecode: false`. Source: CLAUDE.md "GEMINI IS PERMANENTLY OUT OF DECODE"; docs/ARCHITECTURE.md section 3 + Trap #7.

A10: Charges ONLY the paid rungs (goupc, fetchv2, gpt), exactly once per genuine compute, applied INSIDE the paid path via `chargeDailySlot`. Free/corpus/cache hits never burn a slot. Source: CLAUDE.md "Decode Ladder + Evidence Rules"; LESSONS_LEARNED L12.

A11: Between the free ladder half and the paid ladder half - a LAZY gate that sits AFTER the free corpus/cache peek and BEFORE the paid rungs (pipeline.ts ~1217-1229, right before paid rungs at ~1246+). Source: docs/ARCHITECTURE.md section 3 table rows 7-8; LESSONS_LEARNED L12 rule 1 (charge AFTER the free corpus/cache peek).

A12: It is the LEGACY file-only daily cap used by the `lookup` mode (not the real decode path). New code must NOT add callers to it; the real decode cap is `readDailyUsed`/`chargeDailySlot`. Source: CLAUDE.md bullet under Decode Ladder rules; docs/ARCHITECTURE.md Trap #3.

A13: `markWrong` is a quantity TRANSFER, never a delete. It deactivates the bad aliases, un-verifies the product, and repoints the feed's ScanEvents onto a fresh "Unidentified item" provisional via `incrementInventoryCount` again - total physical quantity is invariant across the identity correction. Source: CLAUDE.md "Architecture at a Glance"; docs/ARCHITECTURE.md section 2 step 7 and Trap #9.

A14: better-sqlite3 (local file, decompresses .db.gz on Vercel) stores the tire/retail knowledge CORPUS; Turso/libsql stores the DECODE CACHE (L2) and ladder USAGE counters. They coexist on purpose and must not be unified casually. Source: CLAUDE.md "Tech Stack" + "Architecture at a Glance"; docs/ARCHITECTURE.md Trap #10.

A15: Automated tests NEVER call live providers. Unit tests mock engines/fetch. E2E tests mock `/api/ai-lookup` via `page.route`, and the Playwright webServer sets `IS_E2E=1`, which forces the route to be mock-only. Source: CLAUDE.md "Decode Ladder + Evidence Rules" TEST SAFETY bullet; DECISIONS.md "Evidence verification" section.

A16: none < url_only < snippet < grounding_chunk < fetched_source. Source: CLAUDE.md "Decode Ladder + Evidence Rules"; docs/ARCHITECTURE.md section 3.

A17: A PUBLIC barcode shape (never X00/FNSKU/vendor/internal) + strong app-verified evidence (single provider or two agreeing) + non-empty identity + confidence >= 0.8. Provider disagreement counts as conflict, not verified. Source: CLAUDE.md "Decode Ladder + Evidence Rules" `decideDecode` bullet; docs/ARCHITECTURE.md section 3.

A18: Phones, emails, obvious names, and cost/price/margin patterns - only technical product fields reach AI. Source: CLAUDE.md "Data Privacy / Semantic Firewall / Key Safety".

A19: No. `detectCodeType` routes them to "vendor_label"; they are never treated as UPC/EAN/GTIN and route to Needs Review unless a human-approved alias exists. Source: CLAUDE.md "Resolver Trust Rules".

A20: NONE. No gate, cap, breaker, or error may suppress a scanned row from the feed or the count - decode/AI/firewalls/trust gate decide identity only. An unidentifiable code still counts as an "Unidentified item" row; any code vanishing from feed/count is a defect. Source: CLAUDE.md "TOP-LEVEL LAW: Every Scan Appears and Counts".

### Difficulty tiers
- Easy (directly stated, single-fact lookup): Q1, Q3, Q5, Q9, Q12, Q13, Q18, Q19 (8 questions)
- Medium (requires combining two facts / locating specific ordering or mechanism): Q2, Q4, Q6, Q7, Q10, Q11, Q14, Q16 (8 questions)
- Hard (subtle traps or precise multi-clause requirements): Q8, Q15, Q17, Q20 (4 questions)
