# Boss Barcode Zero-Review Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every safely linked boss unit GTIN and every valid leading-zero spelling resolves through the same deterministic, zero-network fast path locally and on Vercel Preview, never remains in Needs Review, and never invokes a paid or external decode provider.

**Architecture:** Build a generated, server-only, 64-way hash-sharded exact-barcode index from two separately validated and SHA-pinned partitions: the current admitted global tire corpus and the repair package's explicitly accepted boss rows. Normalize public GTINs to one canonical zero-padding key, reject collisions and the known case-pack code, and consult the index before SQLite or Turso. The authenticated route runs this deterministic fast path before AI kill/rate/cap/storage controls; only a miss may enter those controls and the external ladder. Exact boss-database hits count even when optional display metadata is incomplete, using the honest label `Known tire - <scanned code>` when necessary; no model, size, MPN, or package quantity is invented.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Node 24, Vitest 4, Playwright 1.61, ExcelJS, better-sqlite3, Vercel Preview.

## Problem / Current Evidence

- The boss workbook contains 6,990 source rows, 5,317 distinct valid raw GTINs, and 5,316 safely linked unit GTINs. `30029885620210` is a case-pack GTIN-14 and remains excluded until package quantity is known.
- The repaired database resolves 5,316/5,317 qualified unit codes and 13,346/13,347 permitted raw-or-leading-zero spellings. The current runtime artifact resolves only 3,927/5,317 raw codes and 9,832/13,347 spellings.
- Preview excludes the 369 MB combined SQLite DB, 143 MB gzip, and 72 MB tire JSON in `.vercelignore`, so it performs remote Turso lookups before falling through to a ladder that can take seconds.
- Exact zero-padding candidate generation already works. The defect is corpus delivery/parity plus policy: 660 safely linked boss rows lack model and/or size, and the current tire completeness gate treats missing optional metadata as unresolved even when the barcode-to-product mapping is app-verified.

## Global Constraints

- Every physical scan appears and counts immediately; identity work never suppresses or double-counts it.
- Wrong identity is worse than unknown. Admit only reconciliation `accepted`/`alias` rows with a valid unit GTIN and exactly one product mapping. Reject unresolved rows, invalid checksums, ambiguity, internal codes, and nonzero-indicator case packs.
- Leading-zero equivalence only: UPC-A/EAN-13/zero-indicator GTIN-14 spellings may share one canonical key; never collapse a nonzero package indicator.
- The excluded case-pack code and every canonical spelling that would otherwise reach it return a deterministic `blocked_package` result before legacy SQLite/JSON, Turso, or any provider. A package block remains counted as one physical scan but unresolved as product identity; it is excluded from the zero-review admitted-unit fixture.
- A trusted exact database barcode may count with incomplete descriptive metadata, but missing model/size must stay blank and the visible fallback must include the scanned code. Do not fabricate a model, size, MPN, or package quantity.
- Existing global-corpus records retain their current exposure contract. Repair-only boss records are tagged `authenticated_boss_corpus` but are available only to a platform owner or a verified member of a server-side allowlisted owner-approved business; ordinary authenticated customer businesses receive the same miss shape as an absent code. The allowlist is server-only configuration, fails closed when absent/malformed, is never returned to the client, and cannot be expanded by request JSON or a client environment variable.
- Authorized boss product lookup is an application capability, not a bulk-export API. A bounded in-process per-user-plus-business limiter (default 600 requests/minute), expiry/bounded-memory behavior, `Retry-After`, and anomaly logging provides defense in depth for the privileged/allowlisted population; it performs no Turso/storage/network call and does not reuse or bypass the slower AI limiter on misses. The plan makes no claim that this per-instance limiter is globally durable; access control is the primary corpus boundary.
- The generated index and manifest are server-only build assets. Production-build inspection and HTTP probes must prove no shard, manifest, source map, or barcode content is publicly addressable.
- The deterministic exact path is independent of AI enablement, provider-key status, daily cap, breaker, AI kill switch, and AI rate-limit storage. Those controls still apply byte-for-byte to a miss before any external ladder work.
- Known-index hits perform zero Turso corpus queries, zero fetches, zero UPC-provider calls, and zero GPT calls.
- No live Turso mutation, paid provider, production deployment, Firebase rules deployment, push, merge, or production promotion.
- Preview deployment and isolated QA verification are authorized by the owner's current request. Any customer-business write remains prohibited; use the dedicated non-customer QA identity/session only.
- Preserve all existing dirty-worktree changes. Do not rewrite current generated tire/retail artifacts.

## Acceptance Criteria and Proof

1. Projection gate: exactly 5,316 safely linked boss unit GTINs admitted; exactly one case-pack exclusion; zero unresolved/invalid/ambiguous rows admitted. Existing-global and authenticated-boss partitions are validated independently, and a canonical-key collision with an incompatible identity fails closed. Proof: generator contract test and stable content-manifest hashes.
2. Alias gate: all 13,346 valid raw-or-leading-zero spellings map to the same product identity as their canonical key; zero cross-product canonical-key collisions. Proof: exhaustive index test.
3. Decode gate: every admitted spelling returns `decision.status="verified"`, `exactCodeEvidenceVerifiedByApp=true`, source-appropriate `corroborationPath` (`corpus_exact_barcode` or `boss_trusted_exact_barcode`), `paidComputeCharged=false`, and provider `tire-corpus`, with external fetch forced to throw. Proof: exhaustive provider/pipeline test.
4. Store gate: every admitted exact boss code settles with zero open or suggested Needs Review rows. The union of 660 model/size-incomplete records, including 574 with no usable current display name, is counted only on the server-issued `boss_trusted_exact_barcode` path and receives an honest code-bearing label with no invented fields. Proof: focused RED/GREEN store tests plus exhaustive store harness.
   Equivalent leading-zero spellings settle to one canonical product/count row while each `ScanEvent` retains its raw scanned spelling, stable event id, and physical timestamp. Boss settlement must not upsert the learned/global catalog or create an approved tenant alias.
5. Localhost browser gate: every nonblank Sheet1 boss barcode that is present in the trusted manifest is scanned with focused `page.keyboard.insertText(code)` + Enter; final open/suggested review count is zero and every physical scan is counted exactly once. Proof: Playwright report and JSON receipt.
6. Local performance gate after warmup: exact-index p95 <= 5 ms, cold shard-load p95 <= 50 ms, and externally measured browser end-to-end identity-settlement p95 <= 500 ms. Provider, authorized-route, and browser timings are reported separately; no unsupported queue/auth decomposition is claimed.
7. Preview parity gate: the deployed Preview reports the same non-secret content digest and produces identical decision/product identity for the same exhaustive fixture, with warm authorized route p95 <= 250 ms and zero provider fallback. Exhaustive route requests are paced below the configured limit unless the owner explicitly authorizes a scoped Preview-only test limit. Browser Sheet1 replay has zero open/suggested reviews and exact scan count parity in a proven isolated QA business.
8. Regression gate: focused tests, `npm run test:ledger`, `npm run test:golden`, `npm run test:corpus-drift`, `npm run proof:full`, mock Playwright, `scanbin-certify -Mode full`, and independent diff review all pass for the recorded SHA/worktree state.

## Out of Scope

- Promoting or mutating live Turso tables.
- Auto-resolving the 697 quarantined boss rows or the case-pack GTIN-14.
- Treating ambiguous part numbers as barcodes or app-verified exact-code evidence.
- Repairing missing product metadata by inference or web research.
- Production deployment or production customer testing.

---

### Task 1: Trusted Boss Projection Contract and Generated Index

**Files:**
- Create: `scripts/build-tire-exact-index.mjs`
- Create: `scripts/build-tire-exact-index.node-test.mjs`
- Create: `scripts/tire-exact-index-collision-dispositions.json`
- Create: `src/server/tire-knowledge/exact-index/manifest.json`
- Create: `src/server/tire-knowledge/exact-index/00.json` through `3f.json`
- Modify: `package.json`
- Modify: `docs/COMMANDS.md`

**Interfaces:**
- Requires exact inputs before projection: global corpus SHA `CF61D12208E6E1AA0DCB5BBD2AAA98E775ED7A60110601628BB3EDE9DBFE13D6`, repair DB SHA `ECF1F14400489897A3882964E928DFC28F8056CAC262176E28808B7BA0E42E82`, and reconciliation SHA `DAB216234D5346BAEEFBAE80E5C704F2F3C5D568CC3CA01FD5C4990B44183FFD`.
- Produces a stable content manifest `{ schemaVersion, generatorVersion, shardAlgorithm: "sha256-first-byte-mod-64-v1", approvedCorpusSha256, repairSha256, reconciliationSha256, admittedBossCodes: 5316, acceptedSpellings: 13346, excludedCasePacks: 1, blockedPackageCanonicalKeys, shardHashes, shardCounts, totalKeys, contentDigest }`. `blockedPackageCanonicalKeys` is sorted, contains the canonical key for every excluded package (currently exactly one), and is digest-covered so Task 2 never hardcodes source data. Any wall-clock build time lives only in an ignored receipt and is excluded from the content digest.

- [ ] Write failing Node tests proving pinned input hash enforcement, separate global/boss admission rules, status/checksum/package filtering, exact counts, ambiguity rejection, canonical-key collision rejection, stable deterministic output, maximum total output 40 MiB, maximum shard 1 MiB, balanced shard distribution, and atomic no-partial promotion.
- [ ] Define compatibility for a boss/global canonical-key overlap: barcode package semantics must match and every mutually nonblank semantically normalized brand/model/size/MPN field must agree. Normalizers are narrow and regression-pinned (including `Toyo Tire`/`Toyo` and equivalent `42/13.5R17`/`42X13.50R17LT` syntax), never fuzzy matching.
- [ ] Add a reviewed, deterministic collision-disposition ledger for the exhaustive set of 42 proven exact-barcode/same-identity MPN disagreements across 4,201 boss/global overlap rows. Each entry pins canonical GTIN, both source pointers, both exact values, and action `omit_conflicting_field`; the projected overlap emits blank MPN. Record the ledger hash and disposition count in the stable manifest/content digest. Any unlisted disagreement, changed pointer/value, extra ledger entry, non-MPN conflict, or count drift fails closed. No source-order winner or manufacturer-specific MPN heuristic is allowed.
- [ ] Run `node --test scripts/build-tire-exact-index.node-test.mjs`; verify RED for the missing builder.
- [ ] Implement the builder using read-only inputs, staging output in a unique sibling temp directory, validating every shard/hash/count before promotion, and preserving the prior generated index on any failure.
- [ ] Emit only the minimal `TireKnowledgeRow` fields required by `TireKnowledgeProvider`, plus server-only source scope `global_corpus|authenticated_boss_corpus`; do not include provenance URLs or customer-sensitive workbook columns. Non-GTIN boss inputs are rejected rather than normalized.
- [ ] Run the Node tests GREEN, run the real build once, rerun in check/determinism mode, and record file count/size/hash.

### Task 2: Server-Only Exact Index Loader and Lookup-First Integration

**Files:**
- Create: `src/server/tire-knowledge/tireExactIndex.ts`
- Create: `src/server/tire-knowledge/tireExactIndex.test.ts`
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts`
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.turso.test.ts`
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.ts` only to preserve the discriminated package-block/source-scope result into Task 3.
- Modify: `next.config.ts`
- Create: `scripts/assert-tire-exact-index-trace.mjs`
- Modify: `package.json` with the offline trace assertion command.

**Interfaces:**
- Produces `lookupTrustedExactBarcode(code: string, access: { authenticatedBossCorpus: boolean }): { kind: "hit"; row: TireKnowledgeRow; sourceScope: "global_corpus" | "authenticated_boss_corpus" } | { kind: "blocked_package"; canonicalKey: string } | null` and `getTireExactIndexFingerprint(): { schemaVersion: string; contentDigest: string }`. The boolean is an internal capability already derived from platform-owner status or verified membership in the server-side business allowlist, never mere authentication.
- Add an internal discriminated exact-decision API consumed by `TireKnowledgeProvider`: trusted hit, package block, legacy hit, or miss. Preserve existing `lookupByExactBarcode(): Promise<TireKnowledgeRow | null>` as a source-compatible wrapper; it returns the row for either hit and `null` for package block/miss, but a package block stops before SQLite, Turso, or legacy JSON. Only a trusted-index miss may reach legacy lookup.

- [ ] Write failing tests for exact raw, UPC-A/EAN-13/zero-indicator GTIN-14 equivalence, case-pack separation, authenticated-boss authorization, 64-way hash placement, cache reuse, missing/corrupt shard fail-closed behavior, and proof that Turso is not called on an index hit. For the excluded case-pack and every equivalent spelling, require `blocked_package` and prove zero legacy/Turso/provider fallback.
- [ ] Run focused Vitest and verify RED because the loader does not exist.
- [ ] Implement a server-only SHA-256 hash-shard loader with bounded in-process caching. Use canonical GTIN for public codes only; do not admit non-GTIN boss codes or read the whole index at startup.
- [ ] Preserve `hit` source scope and `blocked_package` as discriminated outcomes through the provider boundary; never collapse a package block to a nullable miss. Reset the shard cache from the existing test reset seam.
- [ ] Add explicit Next.js output-file tracing for the generated server-only shards after reading the installed Next 16 guide under `node_modules/next/dist/docs/`; add an offline post-build trace/output assertion for all 64 shards and the manifest while proving the old 72 MB JSON/369 MB DB remain excluded.
- [ ] Run focused index/Turso/JSON fallback tests GREEN and verify a known miss still follows the old path.

### Task 3: Authenticated Deterministic Route Before AI Controls

**Files:**
- Modify: `src/server/decode/pipeline.ts`
- Modify: `src/app/api/ai-lookup/route.ts`
- Modify: `src/app/api/ai-lookup/route.test.ts`
- Modify: `src/app/api/ai-lookup/route.d4.test.ts`
- Modify: `src/types.ts`
- Create: `src/services/security/trustedExactRateLimit.ts`
- Create: `src/services/security/trustedExactRateLimit.test.ts`

**Interfaces:**
- Produces `tryTrustedExactDecode(input, access: TrustedExactAccess): Promise<ComputedPipelineOutcome | null>` and reuses it from both the route and normal pipeline. `TrustedExactAccess.authenticatedBossCorpus` is route-derived, never accepted from JSON, and defaults false for every direct caller.
- Adds request flag `deterministicOnly?: boolean` (may reduce work, never expand authority) and server decision path `boss_trusted_exact_barcode`.

- [ ] Write failing route tests proving an authorized boss exact hit succeeds before kill switch, the AI rate limiter, daily/account caps, `ladderStorage`, Turso, master-catalog append, or provider calls; Firebase identity, business membership, and platform-owner/server-side allowlist authorization complete before any authenticated-boss shard load; an ordinary authenticated but non-allowlisted business has the same miss shape as an absent code; missing/malformed allowlist fails closed; request JSON and `NEXT_PUBLIC_*` values cannot grant access; a miss retains every old guard/status/charge behavior. Prove the separate defense-in-depth limiter keys by verified user plus business, allows the scanner-rate default, expires and bounds memory, emits `Retry-After` plus anomaly telemetry, and performs zero storage/network work.
- [ ] Write a case-pack route/pipeline test proving every equivalent spelling returns the deterministic package block with zero legacy/Turso/provider work.
- [ ] Write failing tests proving `deterministicOnly:true` returns an immediate no-result miss without touching external/storage seams, while an exact hit returns the normal verified result.
- [ ] Run RED and verify current ordering blocks or touches storage before corpus lookup.
- [ ] Refactor POST ordering to parse/sanitize and complete live auth/membership first, then invoke `tryTrustedExactDecode`; only a miss continues through kill/rate/cap and the existing pipeline. Do not move any paid/external work ahead of a guard.
- [ ] Reuse the same helper inside `runDecodePipeline` so direct callers and route callers cannot drift. Direct pipeline access defaults to `authenticatedBossCorpus:false`; local certification uses an injected test-only capability that throws under `NODE_ENV=production` and cannot be enabled by an environment flag or request body. Keep non-E2E outcome telemetry injectable/no-op in certification.
- [ ] Return only the non-secret `{ schemaVersion, contentDigest }` fingerprint inside an authenticated successful exact-decode debug payload; do not add it to the anonymous GET status. Test that it reveals no keys, counts, rows, or source paths.
- [ ] Run route, auth-order, spend/cap, pipeline, and security tests GREEN.

### Task 4: Deterministic Lookup Independent of AI Configuration

**Files:**
- Modify: `src/stores/scanStore.ts`
- Modify: `src/stores/scanStore.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- `liveDecode(reviewId, options?: { deterministicOnly?: boolean })` and `runLiveDecodeOnce` pass `deterministicOnly` to the server.
- Online valid GTIN unknowns always attempt deterministic lookup; `evaluateAutoDecode` controls only whether a miss may continue into external decode.

- [ ] Write failing tests for known exact hits while AI is disabled, provider keys are missing, daily cap is reached, breaker is open, and kill switch is on; each must close review with no external provider call.
- [ ] Write negative tests proving offline and bad-check-digit scans make no request, and deterministic misses remain counted/reviewable without external work when the AI gate is closed.
- [ ] Write a deferred `deterministicOnly` request regression: immediately after `processScan`, before POST resolution, assert exactly one feed event and one provisional ledger event/count with stable id; after resolving verified, assert identity-only settlement with no duplicate increment and final ledger replay parity.
- [ ] Define and test a bounded drain contract for rapid scanner bursts: physical rows/counts remain immediate, active deterministic requests never exceed the existing concurrency bound, queued work stays under a documented certification window (the harness must pause input and drain before exceeding it), and every exact result settles without loss or duplication.
- [ ] Implement the narrow dispatch change in both the direct and cloud-catalog-miss paths; do not change the top-law provisional count ordering or decode concurrency bound.
- [ ] Run focused store gate/queue/abort/count-first tests GREEN.

### Task 5: Trusted Exact Identity With Incomplete Optional Metadata

**Files:**
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.ts`
- Modify: `src/stores/scanStore.ts`
- Create or modify: `src/stores/scanStore.trustedExactIncomplete.test.ts`
- Modify: `src/components/NeedsReviewTable.tsx` tests only if rendering contract requires it.

**Interfaces:**
- Global exact-index hits keep `corroborationPath="corpus_exact_barcode"`; authenticated boss additions use `corroborationPath="boss_trusted_exact_barcode"`. Both keep `status="verified"` and `exactCodeEvidenceVerifiedByApp=true`.
- Store gate distinguishes server-issued `boss_trusted_exact_barcode` from generic corpus/AI/provider claims and allows count settlement without model/size completeness only for that path.

- [ ] Write a failing store test with a server-issued authenticated-boss exact result missing brand/model/size; assert it is counted once, labeled exactly `Known tire - <scanned code>`, and leaves zero open/suggested reviews. Scan UPC-A/EAN-13/zero-indicator GTIN-14 equivalents and prove they settle to one canonical product/count row while each event retains its raw spelling, stable id, and physical timestamp.
- [ ] Write negative tests proving identical incomplete data from AI, UPC provider, part-number suggestion, ambiguous/collision status, or self-claimed `verified` still remains reviewable.
- [ ] Run RED and verify the positive case fails at the existing tire completeness gate.
- [ ] Implement the narrow trusted-exact bypass at both live and background-deep store trust boundaries, not in generic tire specs. Update provider result shaping to use the honest fallback label only for authenticated-boss exact hits. Keep all firewall/context/check-digit/example-code gates intact.
- [ ] Fix misleading `hasSuggestion=true` when no usable suggestion exists, with its own failing-first regression test.
- [ ] Add a boss-specific settlement origin and prove it does not upsert the learned/global catalog or create an approved tenant alias. Assert an empty catalog/alias state stays empty after exhaustive settlement, reload, and ledger replay while reviews resolve and feed events become terminal verified on the original rows.
- [ ] Run focused store, trust, suggestion, and ledger tests GREEN.

### Task 6: Exhaustive Offline/Localhost Certification Harness

**Files:**
- Create: `scripts/certify-boss-barcodes.mjs`
- Create: `scripts/certify-boss-barcodes.node-test.mjs`
- Create: `e2e/boss-barcode-corpus.spec.ts`
- Create: `playwright.corpus.config.ts`
- Modify: `package.json`

**Interfaces:**
- CLI modes: `--target direct|localhost|preview`, `--base-url`, `--manifest`, `--receipt-dir`, `--max-provider-calls=0`.
- Receipt includes content digest, target fingerprint, total/unique scans, decisions, open/suggested review count, count parity, provider attempts, and separate p50/p95/max direct-provider, authorized-route, and browser end-to-end timings, plus masked failure samples.

- [ ] Write failing harness tests for manifest mismatch, any review row, any provider/fetch attempt, count loss/duplication, timeout, and receipt integrity.
- [ ] Run RED because the harness does not exist.
- [ ] Implement exhaustive direct provider/pipeline evaluation of all 13,346 spellings with an injected in-memory/no-op ladder storage, Turso/provider keys removed, every fire-and-forget persistence seam disabled, and `global.fetch` throwing.
- [ ] Implement a dedicated corpus-certification server mode that does not set `IS_E2E=1`, strips all provider/Turso credentials, enables only the generated index, and fails closed on any attempted external egress. Replay every trusted nonblank Sheet1 barcode using atomic insertion + Enter without a preparatory click. Assert first-scan autofocus, Enter cannot activate another control, scanner input remains `document.activeElement` after sampled and final scans, and typing in an unrelated field is not hijacked. Use a documented pacing window that both pauses/drains before the pending queue ceiling and remains below the trusted-exact requests-per-minute limit; prove zero limiter rejection, immediate rows/counts, terminal verified settlement on the same event ids/timestamps, canonical product-row identity, zero catalog/alias contamination, and exact ledger replay.
- [ ] Keep generated receipts under ignored `outputs/`; never embed boss codes in user-facing logs beyond masked failure samples.
- [ ] Run direct and localhost certifications GREEN twice to detect flakes.

### Task 7: Independent Review and Full Local Gates

**Files:**
- Modify: `PROGRESS.md` by appending a conflict-safe checkpoint only after reviewing its existing dirty content.
- Create: `docs/superpowers/reports/2026-08-03-boss-barcode-fast-path-review.md`

- [ ] Dispatch independent feasibility, data-integrity, scanner-flow, security/tenant, and performance reviewers over the complete diff; each must cite exact lines and return blocking/nonblocking findings.
- [ ] Convert every blocking finding into a failing regression test, fix through RED/GREEN, and rerun the affected lane.
- [ ] Run focused lint on touched paths, `npm run test:ledger`, `npm run test:golden`, `npm run test:corpus-drift`, `npm run proof:full`, and mock E2E.
- [ ] Run `scanbin-certify -Repo C:\Users\djsan\inventory -Mode full`; require `CERTIFIED_LOCAL` for the recorded code/artifact state.
- [ ] Append exact commands, outputs, content digest, latency distribution, and remaining coverage gaps to the report and `PROGRESS.md` without overwriting unrelated work.

### Task 8: Authorized Vercel Preview and Identical Certification

**Files:**
- Modify only deployment evidence/receipt files under ignored `outputs/`.

- [ ] Verify the Vercel CLI executable, version, authenticated identity, linked project, Preview environment names, and current deployment path. If the CLI is absent, install it with `npm i -g vercel` after the required system approval.
- [ ] Run `npm run release:check`, `node scripts/check-fix-lineage.mjs`, `node scripts/check-env-parity.mjs --env=preview`, and `node scripts/deploy-preview.mjs --dry-run`.
- [ ] Deploy Preview through the project wrapper only; never use `--prod`, alias promotion, or production rollback commands.
- [ ] Verify smoke fingerprint, content digest, route capability, auth boundary, server-asset non-addressability, and zero provider fallback for a small known sample before exhaustive traffic.
- [ ] Before browser writes, prove exact Firebase project, dedicated non-customer QA business, platform-owner or server-side allowlist authorization, account role, session isolation, and cleanup/retention protocol. Run the identical exhaustive Preview route certification and trusted Sheet1 Playwright replay using only that QA session; pace both below the configured limiter and require the receipt to prove zero trusted-exact limiter rejection. Require zero open/suggested reviews, exact count parity, identical identities, and latency targets.
- [ ] If Preview differs, stop deployment claims, trace artifact/env/route fingerprints, fix locally with a failing test, redeploy a fresh Preview, and rerun every Preview gate.

## Rollback

- Code rollback is removal of the lookup-first integration and trusted-exact store exception; legacy SQLite/Turso/ladders remain untouched.
- Artifact generation is atomic and retains the previous complete shard directory until the replacement validates.
- Preview rollback means abandoning the Preview deployment. No production alias, production deploy, Firebase rule, or Turso state is changed.

## Spend

- OpenAI/Codex agents use the ChatGPT subscription lane only; no `OPENAI_API_KEY`.
- Corpus build/tests/local browser are offline and $0.
- Known-code Preview certification must execute zero paid/external decode providers. Vercel/Firebase/Turso platform usage is operational, not estimated from response metadata.
