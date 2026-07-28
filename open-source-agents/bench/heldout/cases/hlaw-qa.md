# Case: hlaw-qa (20 NEW held-out questions, zero overlap with bench/cases/law-qa.md)

## Task prompt (what the subject model sees)
Answer each question about the Scanbin inventory project precisely and concisely.

## Questions (shown to subject)
Q1: What port does the mock Playwright E2E suite run on, and what port do the QA human-bots run on?

Q2: What does `npm run qa:revision` actually run (list the gates it chains)?

Q3: Name two brand families the app models as evidenced corporate ownership (one company owning multiple tire brands), and why does this matter for the prefix firewall?

Q4: Under the Firebase security model, how is a business's tenant data scoped in Firestore, and why was a top-level-collection-plus-`businessId`-field design rejected?

Q5: What is `catalogEntries` and who is allowed to write to it directly from a client?

Q6: What must a Firestore tenant-isolation test use to sign in, and why is the service role forbidden for the isolation assertions themselves?

Q7: What environment variable controls the daily AI decode cap's default value, and what is that default?

Q8: What is `AI_LOOKUP_KILL_SWITCH` (name a related spend-guard env var) and what category of variables must never be read from client code?

Q9: What is the approximate size (row count order of magnitude) of the retail knowledge corpus, and roughly how does it compare to the tire corpus?

Q10: Which npm script backs up the paid decode cache, and why does that backup exist (what does it protect against)?

Q11: What test file mechanically enforces that client code never reads `*_API_KEY`?

Q12: What does `test:corpus-drift` check, and does it use Turso?

Q13: Which known Vitest test is documented as timing-flaky, and under what condition does it flake?

Q14: What does the `postinstall` script `scripts/patch-jwks-rsa.cjs` fix?

Q15: When merging decode identities, what distinguishes `auto_link` from `suggest_link` in `identityMerge.ts`?

Q16: What was the root cause of the "confidence-based auto-verify" era bug where a review row showed "92%" but was still held from counting, and how was it fixed?

Q17: What is `bizFieldOk` in the Firestore rules, and what class of attack does it defend against as "defense in depth"?

Q18: Trap question: can a customer-role browser ever download or persist the raw alias/catalog database? What mechanism keeps that data server-side?

Q19: What lesson (from LESSONS_LEARNED) explains why gates must always be run with an explicit `cd` into the project directory, and what happened when that rule was violated?

Q20: Trap question: does `npm run dev` (no flags) ever write to real production Firestore data? Which script would be required for that, and what visual signal does the dev launcher show for each backend mode?

## GROUND TRUTH (never shown to subject)

A1: Mock Playwright E2E runs on port 3100 (`playwright.config.ts`); QA human-bots run on port 3300 (`playwright.bots.config.ts` / `.bots.cloud.config.ts`). Source: docs/COMMANDS.md "Port map"; also mirrored in CLAUDE.md "Ports" line.

A2: The full handoff gate: `tsc` + eslint (src + e2e) + `next build` + mock E2E + `test:firebase` + `qa:bots`. Source: docs/COMMANDS.md "E2E (Playwright)" table row for `qa:revision`; docs/REVISION_GATE.md.

A3: Michelin owns BFGoodrich and Uniroyal (NA); Continental owns General; Goodyear owns Cooper (Dunlop was unfamilied after the 2025 Sumitomo trademark purchase). This matters because `sameBrandFamily` feeds `evaluatePrefix` so shared GS1 prefixes inside one company never falsely trigger the prefix firewall/conflict (a same-company product would otherwise look like a brand-prefix conflict, e.g. Michelin vs. its own subsidiary BFGoodrich). Source: DECISIONS.md "Size-aware identity merge + evidenced brand families"; CLAUDE.md "Brand sanity" bullet.

A4: Business-scoped data lives under path-based subcollections `/businesses/{businessId}/...` (products, aliases, settings, shopOverrides, countSessions, scanEvents, inventoryCounts, unknownCodeReviews, auditLog). A top-level-collection-with-a-`businessId`-field design was rejected because Firestore's `resource` is null during `list`/query rule authorization, so a rule that dereferences `resource.data.businessId` throws an "evaluation error" on list/query (works only for single-doc `get`). Path-based tenancy lets `isMember(bid)` be derived from the PATH wildcard, uniformly enforcing get/list/create/update/delete and making a forged `businessId` write impossible. Source: FIREBASE_SECURITY.md "Tenancy by path"; LESSONS_LEARNED L9; DECISIONS.md "Backend pivot: Supabase -> Firebase".

A5: `catalogEntries` is a global, shared, top-level collection (not under a business path). Any signed-in user can READ it; client writes are DENIED - only server/Admin SDK can write it. Source: FIREBASE_SECURITY.md "Rule highlights".

A6: Tenant-isolation tests must sign in as real AUTHENTICATED users (User A / User B), not the service role. The service role (`withSecurityRulesDisabled`) is used ONLY to seed/setup data, because it BYPASSES Firestore rules entirely - a test using it for the actual read/write assertions would prove nothing about real access control. Source: FIREBASE_SECURITY.md "Proof (emulator, authenticated users)"; LESSONS_LEARNED L8.

A7: `AI_LOOKUP_DAILY_LIMIT`; default is 2000 per docs/COMMANDS.md "Environment variables" section and CLAUDE.md "The daily AI cap (default 2000, `AI_LOOKUP_DAILY_LIMIT`)" bullet. (Note: DECISIONS.md records an earlier raise from 200 to 500 on 2026-07-10; the currently documented default in CLAUDE.md/COMMANDS.md is 2000 - a subject citing 2000 with COMMANDS.md/CLAUDE.md as source is correct for current truth.)

A8: `AI_LOOKUP_KILL_SWITCH` is one of the spend/rate-guard env vars listed alongside `AI_LOOKUP_RATE_LIMIT`/`_WINDOW_MS`/`_GET_RATE_LIMIT`, `ENABLE_LIVE_AI_LOOKUP`, `ENABLE_AUTO_DECODE_ON_SCAN`, `AI_LOOKUP_MODE`. Client code must never read any `*_API_KEY` variable - that category (AI provider server-only secrets: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GO_UPC_API_KEY`, `FIRECRAWL_API_KEY`, etc.) is server-only, mechanically enforced by `src/services/keySafety.test.ts`. Source: docs/COMMANDS.md "Environment variables" section; CLAUDE.md "Data Privacy / Semantic Firewall / Key Safety".

A9: The retail corpus is ~4 million rows (docs/ARCHITECTURE.md: "~4M-row retail barcode index (Open Food Facts derived)"; DECISIONS/memory corroborate "4,047,273 retail" rows), versus the tire corpus which is far smaller (order of tens of thousands - "78,243 tires" per the chatgpt-audit-verified memory). So retail is roughly two orders of magnitude larger than tires. Source: docs/ARCHITECTURE.md section 1 (`retail-knowledge/`); corroborated by project memory "corpus truth 78,243 tires / 4,047,273 retail".

A10: `node scripts/decode-cache-backup.mjs --dump` (and `--restore <file>`) backs up/restores the PAID decode cache to `backups/*.jsonl`. It exists so a Turso wipe/reset never forces re-paying for decodes that were already paid for once - existing rows win on restore. Source: docs/COMMANDS.md "Data / corpus pipelines" table.

A11: `src/services/keySafety.test.ts`. Source: docs/COMMANDS.md "Environment variables" intro paragraph; FIREBASE_SECURITY.md "Secret safety"; CLAUDE.md "Data Privacy" section.

A12: `test:corpus-drift` is a local, offline corpus gate using plain filesystem reads (no Turso, no skip; wired into `qa:revision`). It checks three things: (1) the real payload barcode key count in `tireKnowledge.generated.json` stays above a 1%-under floor derived at runtime from `meta.json`; (2) payload is never poorer than the manifest (a stale-snapshot regen wiping enrichments would fail this); (3) 10 golden barcodes still resolve. So no, it does not use Turso. Source: docs/COMMANDS.md "Unit tests (Vitest)" table row for `test:corpus-drift`.

A13: `cloudDrainRace.store.test.ts` is documented as timing-flaky only under full parallel Vitest execution load (worker-thread contention affecting real-clock-dependent promise interleaving in the `drainCloudOnce` mutex); it passes when run in isolation. Source: docs/COMMANDS.md "Known flake" line; docs/ARCHITECTURE.md Trap #14.

A14: It fixes firebase-admin's `jose` ESM crash on Vercel. Source: docs/COMMANDS.md "Quirks" section.

A15: `auto_link` fires only on canonical-GTIN equality (exact match); `suggest_link` is fuzzy matching that is SIZE-AWARE for tires (so a same-model-but-different-size decode does not silently auto-link, since re-decodes should link instead of minting duplicates only when truly the same product). Source: docs/ARCHITECTURE.md section 3 "Trust and evidence chain" bullet on `identityMerge.ts`; CLAUDE.md "Identity merge is SIZE-AWARE" bullet.

A16: Root cause: the Tier-3 single-provider evidence cap (`min 79`) capped the MOST COMMON success path - a decode the app had independently confirmed as `verified` with `exactCodeEvidenceVerifiedByApp`/`fetched_source` evidence, but from a single provider/barcode-DB source - pushing its score below the 80 auto-verify threshold, so it sat in Needs Review while the feed still showed a "Verified" badge (a "Verified AI Decode + Unknown" contradiction). Fix: an `appVerifiedStrongEvidence` fast path (status==="verified" AND `exactCodeEvidenceVerifiedByApp`) carries auto-save regardless of tier/threshold, adds +30 to the score and skips the Tier-3 cap, and a UI guard rewrites any "verified but not auto-saved" row to `needs_review` so that contradictory state can no longer exist. Source: DECISIONS.md "Hotfix: verified-decode fast path"; corroborated by CLAUDE.md "Suggested identities... (suggested)" flow context (2026-07-09 era decisions).

A17: `bizFieldOk` is a Firestore rules helper requiring that any `businessId` field present on a document equals the `businessId` from its own PATH. It is defense-in-depth against a forged/mismatched `businessId` field being written into a document that lives under a different business's subcollection path (i.e., even though path-based tenancy already prevents cross-tenant writes structurally, this closes the gap where an in-document field could otherwise disagree with the path). Source: FIREBASE_SECURITY.md "Rule highlights" bullet on business subcollections.

A18: No. A customer browser never persists (or is meant to download) the raw alias/catalog database. Two mechanisms enforce this: (1) client-side, the scanStore's role-aware `partialize` via `scanPersist.ts` ensures a customer browser never persists aliases, catalog, scanFeed, needsReviewQueue, feedback, or cleanup backups; (2) server-side, `POST /api/resolve-scan` does the customer-role resolve via the Admin SDK server-side and returns only a SANITIZED result, explicitly documented as "customer browsers never download the alias/catalog DB." Source: docs/ARCHITECTURE.md section 4 "Role-aware partialize" bullet and section 6 API routes table row for `/api/resolve-scan`.

A19: LESSONS_LEARNED L2. Running `vitest`/`tsc` from the parent folder (`C:\Users\djsan`, one level above the project) matched 500+ unrelated files or reported "tsc not found," producing a misleading/false-green result. The rule: every gate runs from `C:\Users\djsan\inventory` explicitly, and the proof run prints `pwd` first - a green result from the wrong directory is not a green result. Source: LESSONS_LEARNED.md L2; also referenced in DECISIONS.md "Process note (doctrine clean-env gate)".

A20: No - plain `npm run dev` (default, no flags) always uses the MOCK backend (`NEXT_PUBLIC_FIREBASE_BACKEND=0`, auth bypass on) and shows a GREEN banner; it never writes real production data. Real production writes require `npm run dev:prod` specifically (`NEXT_PUBLIC_FIREBASE_ALLOW_PROD=1`), which shows a RED banner and is explicitly owner opt-in only. (`npm run dev:emulator` is the middle mode: Firebase EMULATOR backend, YELLOW banner, requires `npm run emulators` running separately - still not real production.) Source: docs/COMMANDS.md "Dev servers" table; CLAUDE.md "Tech Stack" bullet on Firebase modes.

### Difficulty tiers
- Easy (directly stated, single-fact lookup): Q1, Q5, Q7, Q10, Q11, Q13, Q14, Q19 (8 questions)
- Medium (requires combining two facts / locating specific mechanism or ordering): Q2, Q3, Q4, Q6, Q8, Q9, Q12, Q15 (8 questions)
- Hard (subtle traps or precise multi-clause requirements): Q16, Q17, Q18, Q20 (4 questions)
