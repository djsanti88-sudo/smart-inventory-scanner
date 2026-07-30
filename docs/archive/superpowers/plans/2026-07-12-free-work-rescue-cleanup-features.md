# Free-Work Plan: Rescue, Cleanup, Code Health, Free Features

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute every $0 item the owner approved on 2026-07-12: protect the 165-commit branch
(LFS fix + authorized push), archive-only repo cleanup, code-health fixes, and four free product
features (camera scanning, free API ladder rungs, variance report, CSV import), each phase proven
by tests and closed with an execution report.

**Architecture:** Four sequential phases; tasks inside a phase parallelize where marked. Every
subagent gets ONE task. Features follow TDD against existing seams: camera feeds `ScannerInput`'s
`onScan(raw)` prop; free rungs implement the existing `LadderRung`/`RungOutcome` contract in
`src/server/upc/ladder.ts`; reports/import are pure services under `src/services/` (no React
imports).

**Tech Stack:** Next.js 16, React 19, TypeScript, Zustand, Vitest (node+jsdom), Playwright,
`barcode-detector` (zxing-wasm polyfill) - the ONLY new dependency, install gated in Task 3.1.

## Global Constraints

- **Owner authorizations (2026-07-12):** push `feat/decode-ladder-goupc` to origin AFTER proof
  passes (push only - NO merge, NO production deploy, NO `vercel promote`). Archive-only cleanup:
  DELETE NOTHING; move/untrack/tag instead.
- **Subagent tiering (owner order):** Sonnet for all build/cleanup tasks; Haiku allowed for pure
  file-move tasks; Opus ONLY for Task 2.4/2.5 (monolith splits) and the Phase-4 final review.
- **Never touch:** `benchmark-tire-db-automation` branch (parked), production env,
  `firestore.rules` deploys, live paid APIs (Go-UPC/GPT keys stay untouched; new rungs are free
  and keyless).
- **Test safety:** automated tests NEVER call live providers - mock `fetch`/engines in unit
  tests, `page.route` in E2E, `IS_E2E=1` webServer.
- **Positioning:** the product decodes ANY barcoded product; tires are the beachhead. No
  tire-only naming in new code/UI copy (owner memory `decode-anything-positioning`).
- **Conventions:** no em/en dashes in user-facing copy; services stay pure (no React/next
  imports under `src/services`); every ScanEvent keeps its raw value + idempotency key.
- **Every phase ends with:** relevant test run green (or failures explained), a commit, a
  PROGRESS.md update, and a per-phase section in the final execution report.

---

## Phase 0 - Rescue (sequential, single Sonnet subagent per task, no parallelism)

### Task 0.1: Restore `.gitattributes` (the LFS landmine)

**Files:**
- Modify: `.gitattributes` (currently 0 bytes, tracked)

**Interfaces:**
- Produces: LFS + EOL rules every later commit depends on. MUST land before any task that
  touches `src/server/retail-knowledge/`.

- [ ] **Step 1: Write the file** with exactly this content:

```gitattributes
* text=auto eol=lf
*.ps1 text eol=crlf
*.bat text eol=crlf
*.cmd text eol=crlf
*.png binary
*.webp binary
*.pdf binary
*.db binary
*.gz binary
src/server/retail-knowledge/retailKnowledge.generated.json filter=lfs diff=lfs merge=lfs -text
```

- [ ] **Step 2: Verify the LFS rule is live**

Run: `git check-attr filter -- src/server/retail-knowledge/retailKnowledge.generated.json`
Expected: `... filter: lfs`

- [ ] **Step 3: Verify no accidental staging of the 247MB content**

Run: `git status --porcelain -- src/server/retail-knowledge/` -> expected: empty (clean).
Then `git ls-files -s src/server/retail-knowledge/retailKnowledge.generated.json` and
`git cat-file -s <blob-sha>` -> expected: a small pointer blob (< 200 bytes), NOT ~247MB.

- [ ] **Step 4: Do NOT run `git add --renormalize .` in this task.** Renormalize rewrites line
  endings across the tree and must ride on a green proof run - it happens in Task 0.2 Step 3.

- [ ] **Step 5: Commit**

```bash
git add .gitattributes
git commit -m "fix(git): restore .gitattributes - LFS rule for retail corpus + LF/CRLF policy"
```

### Task 0.2: Full proof run (baseline before push)

**Files:** none created; fixes only if gates fail.

- [ ] **Step 1:** `npx playwright install chromium` (idempotent), then run in order:
  `npm run proof:full` (tsc + vitest + next build), `npm run test:e2e`, `npm run qa:bots`.
- [ ] **Step 2:** Record pass/fail counts + exit codes verbatim into the execution report
  scratch file `docs/archive/superpowers/reports/2026-07-12-free-work-execution.md` (create it, header
  "Execution Report - free-work plan", one section per task from now on).
  Known flake: `cloudDrainRace.store.test.ts` fails only under full parallel load - rerun it
  isolated (`npx vitest run src/stores/cloudDrainRace.store.test.ts`) before calling it a failure.
- [ ] **Step 3:** With all green: `git add --renormalize . && git status --porcelain` - expect
  ONLY line-ending renormalization changes; spot-check one diff (`git diff --cached --stat | head`),
  confirm the 247MB JSON is NOT staged as content (repeat Task 0.1 Step 3 check), commit
  `chore(git): renormalize line endings under restored .gitattributes`, rerun `npm run test`
  to prove renormalize broke nothing.
- [ ] **Step 4:** Real failures = fix within this task (repair loop, max 4 attempts per root
  cause) or document as blocker in the report + PROGRESS.md. Do not weaken tests.

### Task 0.3: Commit stragglers, tag, push (OWNER-AUTHORIZED)

- [ ] **Step 1:** Commit the untracked keepers:

```bash
git add docs/BACKLOG.md docs/archive/superpowers/plans/2026-07-09-decode-ux-fixes.md \
  docs/archive/superpowers/plans/2026-07-10-size-merge-brand-family-fix.md \
  docs/archive/superpowers/plans/2026-07-12-free-work-rescue-cleanup-features.md
git commit -m "docs: backlog + retained plan docs (2026-07-12 audit)"
```

- [ ] **Step 2:** Safety tags on every local branch tip:
  `git for-each-ref --format="%(refname:short)" refs/heads | ForEach-Object { git tag "bkp/2026-07-12/$($_ -replace '/','-')" $_ }`
  (PowerShell; verify with `git tag -l "bkp/2026-07-12/*" | Measure-Object`  -> expect ~19).
- [ ] **Step 3:** Push branch + tags: `git push origin feat/decode-ladder-goupc --tags`.
  If LFS objects are pushed, note the LFS bandwidth used in the report (GitHub free quota 1GB).
- [ ] **Step 4:** Verify remotely: `git ls-remote origin feat/decode-ladder-goupc` returns the
  local HEAD sha. Record in report. NO PR merge, NO deploy, NO vercel commands.

---

## Phase 1 - Archive-only cleanup (Sonnet; 1.1-1.4 parallelizable, 1.5 last)

**Standing rule for every Phase 1 task:** nothing is deleted. Files move under `docs/archive/`
or become untracked via `git rm --cached` (file stays on disk). Commit per task.

### Task 1.1: Untrack `reports/` (37 tracked files despite gitignore)

- [ ] `git rm -r --cached reports/` then `git status --porcelain reports/` -> only `D` index
  entries; files still on disk (`ls reports | head`).
- [ ] Verify rule: `git check-attr -a reports 2>$null; git check-ignore reports/agent-bots -q; echo $?` -> 0.
- [ ] Commit `chore(repo): untrack reports/ (gitignored QA artifacts, files kept on disk)`.

### Task 1.2: Root artifact sweep

- [ ] `mkdir docs/archive/proof-images` then `git mv` all 15 tracked root `*.png` plus
  `cleanup-review-report.html`, `cleanup-review-summary.json`, `competitor-analysis.html`,
  `LIVE_SMOKE_OUTPUT.txt` into it. Add a 5-line `docs/archive/proof-images/README.md` (what
  these are, dates, "moved 2026-07-12, safe to delete on owner order").
- [ ] Untrack runtime counters: `git rm --cached .ai-lookup-usage.json .gpt-ladder-usage.json`
  (gitignore already covers them).
- [ ] Append to `.gitignore`: `/*.png` (root-level only) and `/firestore-debug.log`.
- [ ] Move untracked strays into scratchpad-style archive (no git needed): root `auth`,
  `auth-wal`, and the mangled `C\357\200\272Users...gptladder_base.ts` file ->
  `docs/archive/strays/` (create dir; plain `mv`, they are untracked).
- [ ] Commit `chore(repo): archive root proof artifacts, untrack runtime counters`.

### Task 1.3: scripts/ tmp sweep + README

- [ ] `mkdir scripts/archive-tmp-2026-07` and `git mv` every tracked `scripts/tmp-*`; plain `mv`
  every untracked one (78 total; verify `ls scripts/tmp-* 2>/dev/null | wc -l` -> 0 after).
- [ ] Create `scripts/README.md`: one line per LIVING script (dev.mjs, build-knowledge-db.mjs,
  build-tire-knowledge.mjs, build-retail-knowledge.mjs, build-prefix-index.mjs, cloud-smoke.mjs,
  corpus-purge.mjs, eval-decode.ts, benchmark-decodes.ts, weekly-report.mjs, weekly-intel.mjs,
  release-sentinel.mjs, patch-jwks-rsa.cjs, barcode-harvester/, dt-harvest/, email-report.mjs,
  create-god-account.mjs, backfill-missing-tires.mjs) + a note that `archive-tmp-2026-07/` is
  frozen history, safe to delete on owner order.
- [ ] Commit `chore(scripts): archive 78 tmp-* artifacts, document living scripts`.

### Task 1.4: Doc truth fixes

- [ ] CLAUDE.md: replace the stack line "Local mock data mode (no Firebase wired). Firebase
  Auth/Firestore is a documented future path." with: "Local mock data mode is the default;
  Firebase Phase 2 IS wired (firebaseAdmin.ts, emulator tests via `npm run test:firebase`,
  `qa:bots:live` cloud checks) behind `dev:emulator`/`dev:prod`; production stays mock until
  the go-live gate."
- [ ] PROGRESS.md: new dated entry "2026-07-12 free-work plan started" listing phase status.
- [ ] Commit `docs: CLAUDE.md Firebase reality line + PROGRESS marker`.

### Task 1.5: Branch + worktree hygiene (after 0.3 tags exist)

- [ ] `git worktree remove C:/tmp/inv-decoder-hardening`, `C:/tmp/inventory-demo`,
  `C:/tmp/inventory-release-repair` (NO --force; a dirty worktree = report it, leave it).
- [ ] Delete ONLY branches fully merged into the current branch: for each of
  `git branch --merged feat/decode-ladder-goupc | grep -v "feat/decode-ladder-goupc\|master\|benchmark-tire-db-automation"`,
  `git branch -d <name>` (`-d` refuses unmerged - that is the safety). Every tip already has a
  bkp tag from Task 0.3. Report the surviving branch list.
- [ ] Commit nothing (branch ops don't need one); log results in the execution report.

---

## Phase 2 - Code health (Sonnet: 2.1-2.3 parallel; Opus: 2.4, 2.5 sequential after)

### Task 2.1: Remove dead `autoAcceptVerifiedDecodes`

**Files:** Modify `src/types.ts:226` (approx), `src/stores/scanStore.ts` (DEFAULT_SETTINGS),
CLAUDE.md + docs/DECODER_ARCHITECTURE.md (drop the "declared but DEAD" caveats).

- [ ] Grep first: `grep -rn autoAcceptVerifiedDecodes src/` -> expect ONLY the type def +
  default literal (audit finding). If any other hit appears, STOP and report.
- [ ] Remove both code references; run `npx tsc --noEmit` -> clean; `npm run test` -> green.
  Check persisted-settings migration: if settings objects are versioned, confirm removing an
  unknown key is tolerated by the persist `migrate` (read the migrate fn; removing a field that
  is never read is safe - state it in the report).
- [ ] Update the two doc caveats. Commit `refactor: remove dead autoAcceptVerifiedDecodes setting`.

### Task 2.2: Deprecate legacy `decodeOrchestrator`

**Files:** Modify `src/services/ai/decodeOrchestrator.ts` (header JSDoc), no behavior change.

- [ ] Add `@deprecated` JSDoc: "Legacy concurrent orchestrator - superseded by the decode ladder
  (src/server/upc/ladder.ts) + route computeDecode. Only type exports remain in use." Verify the
  4 known live importers (route.ts, decode/index.ts, decodeFallback.ts, benchmarkAnalysis.ts)
  import TYPES only; if any imports a runtime symbol, report instead of changing behavior.
- [ ] `npm run test` green. Commit `docs(code): mark decodeOrchestrator deprecated (ladder era)`.

### Task 2.3: Missing unit tests for high-risk fetchV2 + tire services

**Files:** Create `src/services/fetchV2/scoring.test.ts`, `src/services/fetchV2/siblingGuard.test.ts`,
`src/services/tire/tirePrefixHints.test.ts`.

- [ ] For each module: READ the source first, then write characterization tests pinning current
  behavior - minimum: scoring: trusted vs untrusted host ordering, outcome decision thresholds,
  empty-evidence path; siblingGuard: same-brand-different-size detected as sibling, identical
  product not flagged, `sizesOf()`/`canon()` edge inputs (empty string, mixed notation
  "225/65R17" vs "2256517"); tirePrefixHints: known prefix -> brand, unknown prefix -> null,
  ambiguous prefix never asserts. Every test must FAIL if the guarded behavior flips (verify by
  temporarily inverting one assertion locally, then restore).
- [ ] `npx vitest run src/services/fetchV2 src/services/tire` -> green; full `npm run test` ->
  green. Commit `test: characterization coverage for fetchV2 scoring/siblingGuard + tirePrefixHints`.

### Task 2.4 (OPUS): Extract decode pipeline from `app/api/ai-lookup/route.ts` (1,097 lines)

**Files:** Create `src/server/decode/pipeline.ts` (+ `pipeline.test.ts`); Modify route.ts to a
thin handler. NO behavior change - this is a pure extraction.

- [ ] Baseline: `npx vitest run src/app/api/ai-lookup` green BEFORE moving anything.
- [ ] Move `computeDecode` + rung-runner builders + cap/breaker helpers into `pipeline.ts`,
  exporting one function `runDecodePipeline(req: AiLookupRequest, deps: PipelineDeps): Promise<DecodePayload>`
  where `PipelineDeps` bundles what route.ts already injects (storage, providers, usage gates).
  Route keeps: request parsing, auth/mock-mode gate (`IS_E2E`), response shaping.
- [ ] Existing route tests must pass UNCHANGED (they are the behavior lock). Add 2 thin
  pipeline tests (all-miss ladder -> needs_review reasons list; cap-blocked -> honest reason).
- [ ] `npm run proof:local` green. Commit `refactor(decode): extract pipeline from ai-lookup route (no behavior change)`.

### Task 2.5 (OPUS): Carve the auto-count gate out of `scanStore.ts` (4,511 lines)

**Files:** Create `src/stores/scanGates.ts` (+ test); Modify `src/stores/scanStore.ts`.
Scope DELIBERATELY narrow (YAGNI): extract ONLY the pure decode auto-count gate + suggestion
auto-apply rules into pure functions; actions/sync stay put for a later plan.

- [ ] Baseline: `npx vitest run src/stores` green (rerun cloudDrainRace isolated if flaky).
- [ ] Extract the gate logic (verified status + app-verified exact code + confidence >= 0.8 +
  tire-specs + public-barcode + no-conflict checks) as
  `canAutoCount(decode: DecodePayload, settings: Settings, ctx: ScanContext): { allowed: boolean; reason: string }`
  and the high-trust suggestion rule as
  `shouldAutoApplySuggestion(decode: DecodePayload): boolean` - both PURE (no store access).
  scanStore imports and calls them; behavior identical.
- [ ] Port the gate's existing store tests to also hit the pure functions directly; full store
  suite green; `npm run qa:bots:data` green (the gate guards counting integrity).
- [ ] Commit `refactor(store): extract pure auto-count gate to scanGates.ts (no behavior change)`.

---

## Phase 3 - Free features (Sonnet builds; ladder-touching tasks get Opus review notes)

### Task 3.1: Camera scan service (pure, testable)

**Files:** Create `src/services/camera/cameraScanner.ts`, `src/services/camera/cameraScanner.test.ts`.
Dependency: `npm install barcode-detector` (~zxing-wasm; the ONE new package - record exact
version in the report).

**Interfaces:**
- Produces: `createCameraScanner(video: HTMLVideoElement, onDetect: (raw: string) => void, opts?: { formats?: string[] }): { start(): Promise<void>; stop(): void }`
  Detection loop: native `window.BarcodeDetector` when present, else dynamic-import polyfill.
  Emits each distinct raw value once per 1500ms window (debounce so one physical barcode does
  not fire 30 times); NEVER transforms the raw value.

- [ ] TDD with a mocked `BarcodeDetector` class (jsdom project): test (a) detected value reaches
  `onDetect` exactly once within the debounce window, (b) two different codes in frame both
  emit, (c) `stop()` halts the rAF/interval loop, (d) constructor prefers native detector when
  `window.BarcodeDetector` exists (spy), falls back to polyfill import otherwise.
- [ ] `npx vitest run src/services/camera` green. Commit per TDD cycle.

### Task 3.2: Camera button UI -> same scan path

**Files:** Create `src/components/CameraScanButton.tsx` (+ test); Modify the scan page where
`ScannerInput` is rendered (locate via `grep -rn "ScannerInput" src/app`).

- [ ] Button "Scan with camera" opens an overlay: `<video>` + getUserMedia
  (`{ video: { facingMode: "environment" } }`), wires `createCameraScanner`, and on detect calls
  the SAME `onScan(raw)` prop the keyboard path uses, closes overlay, refocuses the scan input
  (scanner-workflow rule). Permission-denied and no-camera states show plain-language copy.
- [ ] Component tests (jsdom, getUserMedia mocked): detect -> onScan called with raw value ->
  overlay closed -> input refocused; denied -> message, no crash.
- [ ] E2E (Playwright, chromium flags `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`):
  page loads, camera overlay opens/closes; decode itself stays mocked (`page.route` on
  /api/ai-lookup). Screenshot to `e2e/proof/camera-scan.png`.
- [ ] `npm run test && npm run test:e2e` green. Commit `feat(scan): camera scanning via BarcodeDetector with zxing-wasm fallback`.

### Task 3.3: Free rung 1 - UPCitemdb (before Go-UPC)

**Files:** Create `src/server/upc/UpcItemDbProvider.ts` (+ test); Modify
`src/server/upc/ladder.ts:58-80` (add runner + rung), `src/app/api/ai-lookup/route.ts` (or
`src/server/decode/pipeline.ts` if Task 2.4 landed) to inject it.

**Interfaces:**
- Consumes: `LadderRung`/`RungOutcome` contract (ladder.ts:18-33); GTIN gate helpers
  `isGtinShaped`/`isValidCheckDigit`; the same injected-deps style as `GoUpcProvider.ts`.
- Produces: `LadderRungRunners.runUpcItemDb: () => Promise<RungOutcome>`; rung order in
  `buildLadderRungs` becomes `[upcitemdb, goupc] (both GTIN-gated) -> fetchv2 -> gpt`.

- [ ] **Step 0 (gate):** verify ToS: free tier endpoint
  `https://api.upcitemdb.com/prod/trial/lookup?upc=<gtin>` - keyless trial tier, 100/day per IP,
  burst limited; confirm current terms allow commercial lookup use + whether attribution/linkback
  is required (WebFetch devs.upcitemdb.com). Record verdict in the report; if terms forbid our
  use, SKIP the wiring and report (the task is then docs-only).
- [ ] Provider (injected fetch + clock + daily-counter storage like `goUpcUsage`): GTIN-gated by
  the caller; hard local cap 90/day (buffer under 100) with counter file/storage entry; response
  mapping: `items[0]` -> identity (title/brand/category + offers ignored); NO cap charge (free
  rung never touches the paid daily cap - LESSONS_LEARNED L12 pattern: the free rung records
  usage in its OWN counter); timeouts 5s; on 429/timeout/miss -> `settled:false` with honest
  reason. A hit is a SUGGESTION (confidence <= 0.7, `exactCodeEvidence` NOT app-verified - a
  single free-DB claim never auto-counts) unless the store gate independently verifies.
- [ ] Unit tests (mock fetch): hit -> settled suggestion payload; miss -> unsettled "upcitemdb: no match";
  daily cap -> unsettled "upcitemdb: local daily limit"; timeout -> unsettled; malformed JSON ->
  unsettled, no throw. Ladder-order test in `ladder.test.ts`: valid GTIN -> rungs
  `["upcitemdb","goupc","fetchv2","gpt"]`; non-GTIN -> `["fetchv2","gpt"]`.
- [ ] OPUS REVIEW NOTE: an Opus reviewer confirms the rung cannot auto-count on its own claim
  (Resolver Trust Rules) before merge to the branch.
- [ ] `npm run test` green. Commit `feat(decode): free UPCitemdb rung ahead of paid Go-UPC (GTIN-gated, self-capped)`.

### Task 3.4: Free rung 2 - Open Food Facts live API (after UPCitemdb, before Go-UPC)

**Files:** Create `src/server/upc/OpenFoodFactsProvider.ts` (+ test); Modify ladder wiring as in 3.3.

- [ ] Endpoint `https://world.openfoodfacts.org/api/v2/product/<gtin>.json` (keyless, ODbL,
  ~15 req/min): provider mirrors 3.3 (injected fetch, 10/min local throttle, 5s timeout,
  suggestion-only, own usage counter, honest unsettled reasons). Map `product.product_name` +
  `brands` + `categories_tags[0]`. Requires User-Agent header
  `SmartInventoryScanner/1.0 (djsanti88@gmail.com)` per OFF API rules.
- [ ] Same unit-test matrix as 3.3 + rung-order test: valid GTIN ->
  `["upcitemdb","openfoodfacts","goupc","fetchv2","gpt"]`.
- [ ] `npm run test` green. Commit `feat(decode): free Open Food Facts live rung (suggestion-only, throttled)`.

### Task 3.5: Variance / shrinkage report

**Files:** Create `src/services/reports/varianceReport.ts` (+ test),
`src/components/VarianceReport.tsx` (+ test); Modify scanStore.ts minimally: add
`snapshotCount(label: string): CountSnapshot` + persisted `countSnapshots: CountSnapshot[]`
(capped at last 12) - read the persist `migrate` pattern and bump/extend it the same way
existing versions do.

**Interfaces:**
- Produces: `computeVariance(a: CountSnapshot, b: CountSnapshot): VarianceRow[]` where
  `CountSnapshot = { id: string; label: string; takenAt: string; lines: Array<{ productId: string; name: string; qty: number }> }`
  and `VarianceRow = { productId: string; name: string; prevQty: number; currQty: number; delta: number }`
  sorted by `Math.abs(delta)` desc; products present in only one snapshot appear with the other
  side as 0.

- [ ] TDD the pure service first: added/removed/changed/unchanged products, empty snapshots,
  duplicate productIds rejected. Then store: snapshot captures current finalCounts, persists
  across reload (persist test), cap-at-12 eviction test. Then UI: "Save count snapshot" button
  on the counts page + a compare view (two dropdowns + table + existing CSV-export pattern for
  download); no raw-code columns for customer roles (customer data firewall).
- [ ] E2E: seed scans -> snapshot -> change counts -> snapshot -> variance table shows delta;
  screenshot `e2e/proof/variance-report.png`. `npm run qa:bots:security` still green (no new
  leak surface).
- [ ] Commit `feat(reports): count snapshots + variance/shrinkage report`.

### Task 3.6: CSV import onboarding

**Files:** Create `src/services/csvImport.ts` (+ test), `src/components/CsvImportPanel.tsx`
(+ test); Modify the products (or settings) page to host the panel.

**Interfaces:**
- Produces: `parseCsvImport(text: string): { rows: ImportRow[]; errors: ImportError[] }` and
  `applyCsvImport(rows: ImportRow[], store: ImportTarget): ImportSummary` where
  `ImportRow = { name: string; sku?: string; barcode?: string; qty?: number }`,
  `ImportError = { line: number; reason: string }`,
  `ImportSummary = { created: number; merged: number; aliasesAdded: number; skipped: number }`.

- [ ] TDD the parser (csv-parse, already a dependency): header mapping (case-insensitive
  name/sku/barcode/qty + common synonyms "product","upc","ean","quantity","count"), bad rows
  collected as errors never thrown, values treated as UNTRUSTED DATA (semantic firewall: no
  eval, no instruction-following; strip control chars; length-cap fields at 500).
- [ ] TDD apply: barcode matching an existing product -> merge (qty adds, alias untouched);
  new product -> created with alias `{ approved: true, source: "csv_import" }` (owner's own
  list = human-provided truth, consistent with resolver trust rules - a HUMAN supplied the
  mapping); re-importing the same file -> idempotent (0 new products; test proves it) using a
  content-hash import id in the idempotency-key pattern the store already uses.
- [ ] UI: file input + preview table (first 20 rows + error list) + explicit "Import N products"
  confirm button (no silent import). E2E with a fixture CSV; screenshot `e2e/proof/csv-import.png`.
- [ ] Commit `feat(onboarding): CSV import with preview, idempotent apply, firewall sanitization`.

---

## Phase 4 - Verification + execution report (Opus review, Sonnet mechanics)

### Task 4.1: Full-suite verification

- [ ] Run: `npm run proof:full`, `npm run test:e2e`, `npm run qa:bots:all`. All green or each
  failure root-caused in the report. Rerun the loved-baseline regression guard: the 100-code
  flow must still be 100/100 on the mock path (run the existing owner-code e2e/bot suite that
  covers it; do NOT hit live providers).
- [ ] `git push origin feat/decode-ladder-goupc` (already authorized; push only).

### Task 4.2 (OPUS): Final review + comprehensive execution report

- [ ] Opus subagent reviews the full phase diff (`git diff <phase0-start>..HEAD --stat` + reading
  the ladder/store/gate changes) against: Resolver Trust Rules, scanner-workflow rules, test
  safety, archive-only compliance, no em/en dashes in new UI copy. Findings fixed or logged.
- [ ] Finalize `docs/archive/superpowers/reports/2026-07-12-free-work-execution.md` using the doctrine
  full-report format: per-task terminal proof (command/result/exit code), files changed, tests
  added, proof artifacts (screenshot paths), acceptance results, proof types
  (mocked/live/manual/automated), git status, known limitations, next recommended step, and a
  wallet line (subscription, $0 cash; note any GitHub LFS bandwidth consumed).
- [ ] Update PROGRESS.md, CHANGELOG.md, TESTING.md (new commands/suites), LESSONS_LEARNED.md if
  anything bit us. Commit `docs: free-work execution report + memory files`.
