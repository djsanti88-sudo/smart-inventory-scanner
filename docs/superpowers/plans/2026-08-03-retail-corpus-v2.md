# Retail Corpus V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-evidence-rich retained corpus, deterministic review receipts, and a cleaner backward-compatible serving projection from the complete local Open Food Facts export.

**Architecture:** Preserve the four-field runtime projection and current runtime quarantine behavior. Expand the streaming OFF retained source, classify unique GTIN projections, emit compact review/drift receipts, and rebuild the slim knowledge database with enforced literal and zero-padding-family uniqueness. Do not create a duplicate curation database.

**Tech Stack:** Python 3.12 standard library streaming CSV/gzip, Node.js 20+ ESM, better-sqlite3, Node test runner, Vitest, Next.js 16 build.

## Global Constraints

- Every physical scan continues to appear and count; identity data never gates counting.
- Wrong identity is worse than unknown. Only exact source `product_name` may enter the known serving name.
- Alternate/generic names, local categories, images, country, quantity, and source metadata are evidence, not inferred identity.
- Review/quarantined rows never enter the runtime `retail` table.
- No live/paid APIs, production writes, Firebase/Turso imports, deploys, pushes, or publishing.
- Preserve the current dirty worktree and current uncommitted tire corpus source.
- Do not hand-edit generated JSON or SQLite artifacts.
- Every behavior change follows observed RED, minimal GREEN, and refactor.
- Use versioned generated artifacts, a manifest promoted last, and timestamped local backups before the full rebuild.
- Stop before writing unless the disk/heap preflight passes; snapshot and hash dirty tire input.
- Treat every output as local research until source license/attribution/redistribution review is complete.

---

### Task 1: Streaming OFF evidence retention

**Files:**
- Modify: `data/retail-knowledge/scripts/process_off.py`
- Create: `data/retail-knowledge/scripts/tests/test_process_off.py`

**Interfaces:**
- Consumes: compressed OFF TSV export with its header-driven fields.
- Produces: `normalize_row(row: dict[str, str], source_export_sha256: str) -> dict[str, str]` and an atomically written enriched `retail_off.jsonl`.

- [x] **Step 1: Write failing fixture tests**

Tests must prove a literal fixture retains primary/alternate/generic names, all brand/category assertions, context, provenance, timestamps, quality fields, `_source`, `_source_export_sha256`, and a stable `_payload_sha256`. A second test must prove a failed transform does not replace the existing output.

- [x] **Step 2: Verify RED**

Run:

```powershell
& 'C:\Users\djsan\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest discover -s data/retail-knowledge/scripts/tests -p "test_*.py"
```

Expected: FAIL because the retained schema/hash/atomic API does not exist.

- [x] **Step 3: Implement minimal streaming normalization**

Keep the existing GTIN validator. Add exact header fields from the design, stable canonical-JSON serialization for the source-only row hash, CLI `--input`/`--output`/`--receipt`, versioned output, and promotion only after success. Receipt tests pin raw/valid/invalid/identical-duplicate/conflicting-duplicate/unique/output counts plus source/header/output hashes. Tests prove field-order invariance, duplicate-observation order invariance, preservation of every differing duplicate raw value/hash, deterministic canonical selection, and conflict exclusion from known.

- [x] **Step 4: Verify GREEN**

Run the same unittest command and require zero failures.

### Task 2: Deterministic build-time identity and quality contract

**Files:**
- Create: `scripts/retail-quality.mjs`
- Create: `scripts/retail-quality.node-test.mjs`
- Modify: none of the runtime quarantine files in this phase

**Interfaces:**
- Produces:

```ts
type RetailStatus = "known" | "review" | "quarantined";
type RetailProjection = {
  barcode: string;
  status: RetailStatus;
  productName: string;
  alternateName: string;
  genericName: string;
  brand: string;
  brandBasis: "brands" | "brands_en" | "brand_owner" | "";
  category: string;
  categoryBasis: "main_category_en" | "categories_en" | "";
  categoryRawLocal: string;
  qualityFlags: string[];
  quarantineReason: string;
};
```

- [x] **Step 1: Write failing table-driven tests**

Literal cases prove: primary name only for known; alternate/generic never fill known name; brand precedence; English category precedence; local category evidence only; exact sentinels become empty canonical category; every current poison canary stays excluded; contextual markers are separately flagged but do not change current serving eligibility; every duplicate/variant conflict and every non-quarantined non-known row becomes review; whitespace/entity normalization is reversible because raw values remain unchanged.

- [x] **Step 2: Verify RED**

```powershell
node --test scripts/retail-quality.node-test.mjs
```

Expected: FAIL because the projection/status/duplicate-conflict contract does not exist.

- [x] **Step 3: Implement and share high-precision rules**

Implement the build-time projection without changing runtime quarantine. Freeze parity through shared literal canary fixtures consumed by generator tests and the existing runtime tests. Do not dequarantine any GTIN in this phase.

- [x] **Step 4: Verify GREEN and mutation cases**

Run focused commands. Mutation coverage, if used, operates only on temporary fixture copies; never mutate and restore shared source files.

### Task 3: Backward-compatible serving projection generator

**Files:**
- Modify: `scripts/build-retail-knowledge.mjs`
- Create: `scripts/build-retail-knowledge.node-test.mjs`
- Modify: `src/server/retail-knowledge/retailKnowledge.generated.meta.json` by generator only
- Modify: `src/server/retail-knowledge/retailKnowledge.generated.json` by generator only

**Interfaces:**
- Consumes: enriched `retail_off.jsonl` and `projectRetailRow` from Task 2.
- Produces: unchanged `index[barcode] = [productName, brand, category]`, expanded quality meta, and no partial/quarantine rows in `index`.

- [x] **Step 0: Add and verify a behavior-neutral CLI/path seam**

First extract argument parsing and injectable input/output paths without changing default behavior. Prove equivalence with a temporary fixture and the existing default-path dry/read behavior. This is an enabling refactor, not the new quality behavior; do not execute the pre-refactor CLI against fixtures because it would overwrite tracked artifacts.

- [x] **Step 1: Write failing integration fixtures**

Execute the real generator against a temporary JSONL and temporary output directory. Assert known index compatibility, review/quarantine exclusion, category sentinel removal, frozen poison behavior, duplicate-conflict exclusion, zero-padding-family conflict exclusion, exhaustive classification reconciliation, and barcode-level diff receipts.

- [x] **Step 2: Verify RED**

```powershell
node --test scripts/build-retail-knowledge.node-test.mjs
```

- [x] **Step 3: Add injectable CLI paths and streaming quality meta**

Support `--input`, `--baseline-json`, `--output-json`, `--output-meta`, and `--receipt-dir`; keep existing defaults. Count brand/category raw and effective gaps, normalization reasons, contextual flags, review/quarantine reasons, fallback bases, duplicate conflicts, variant-family conflicts, and source evidence coverage. Emit added/removed/renamed/brand/category/quarantine/dequarantine receipts and fail if dequarantine is nonempty or the known-count floor/drift policy is violated.

- [x] **Step 4: Verify GREEN**

Run the integration fixture and existing JSON consumers/samplers against the fixture format.

### Task 4: Slim knowledge DB uniqueness, completeness, and atomicity

**Files:**
- Modify: `scripts/build-knowledge-db.mjs`
- Create: `scripts/build-knowledge-db.node-test.mjs`
- Modify: `src/server/knowledgeDb.test.ts` only if the generated-path contract changes

**Interfaces:**
- Consumes: existing tire JSON and backward-compatible retail JSON.
- Produces: atomic `knowledge.generated.db` and `.gz`; `retail.barcode` is a primary key/unique constraint.

- [x] **Step 0: Add and verify a behavior-neutral CLI/path seam**

First extract argument parsing and injectable paths while preserving defaults. The pre-refactor builder must never be invoked for RED because it deletes the real local DB. Verify this seam only against disposable fixture paths.

- [x] **Step 1: Write failing real-builder fixture**

Assert the generated table has a primary key by attempting a second direct SQL insert into the disposable fixture DB; assert zero-padding-equivalent conflicting object keys fail before insertion; missing/invalid/LFS-pointer retail fails under `--require-retail`; existing output set survives a failed build; and successful output has expected tables, counts, integrity, gzip hash, and release manifest.

- [x] **Step 2: Verify RED**

```powershell
node --test scripts/build-knowledge-db.node-test.mjs
```

- [x] **Step 3: Implement CLI paths and atomic replacement**

Add explicit input/output/meta/receipt arguments for isolated tests and `--require-retail`. Build DB/GZ as versioned files, validate hashes/counts/integrity, then replace each legacy file atomically and write a generation receipt. Do not claim cross-file atomicity; on a later replace failure, attempt exact-backup restoration and fail. After promotion, decompress the fixed-path gzip to a disposable path and require its DB hash, retail count, and integrity result to equal the fixed-path DB. Make barcode the retail primary key, validate variant-family uniqueness before replace, and require the exact meta retail count.

- [x] **Step 4: Verify GREEN**

Run the builder integration test plus `npx.cmd vitest run src/server/knowledgeDb.test.ts src/server/retail-knowledge/retailKnowledgeIndex.test.ts`.

### Task 5: Full local regeneration and measured repair loop

**Files generated by scripts only:**
- `data/retail-knowledge/retail_off.jsonl`
- `src/server/retail-knowledge/retailKnowledge.generated.json`
- `src/server/retail-knowledge/retailKnowledge.generated.meta.json`
- `src/server/knowledge.generated.db`
- `src/server/knowledge.generated.db.gz`
- audit receipt under `docs/analysis/retail-corpus-v2-2026-08-03/`

- [x] **Step 1: Compute source/artifact sizes and free-space requirement; stop before writes unless the conservative preflight and explicit Node heap setting pass**
- [x] **Step 2: Hash and copy the exact tire JSON plus existing generated artifact set to an explicit timestamped `C:\tmp` directory**
- [x] **Step 3: Regenerate enriched JSONL from the complete local OFF export and validate its raw-to-projection receipt**
- [x] **Step 4: Generate serving JSON/meta/review/diff receipts; require zero unexplained drift and zero dequarantine**
- [x] **Step 5: Recheck tire input hash, then rebuild the slim knowledge DB with `--require-retail` and exact meta-count enforcement**
- [x] **Step 6: Run the read-only full-source reconciliation and quality profiler**
- [x] **Step 7: Repair deterministic failures through new RED/GREEN cycles until count, uniqueness, integrity, status, hash, and drift gates are green**

### Task 6: Documentation, progress checkpoint, and final proof

**Files:**
- Modify: `docs/COMMANDS.md`
- Modify: `PROGRESS.md`
- Create: `docs/analysis/retail-corpus-v2-2026-08-03/README.md`

- [x] **Step 1: Document local/free commands and explicit live/import exclusions**
- [x] **Step 2: Record before/after metrics, artifact hashes, timings, and known limitations**
- [x] **Step 3: Run focused gates**

```powershell
node --test scripts/retail-quality.node-test.mjs scripts/build-retail-knowledge.node-test.mjs scripts/build-knowledge-db.node-test.mjs
& 'C:\Users\djsan\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest discover -s data/retail-knowledge/scripts/tests -p "test_*.py"
npx.cmd vitest run src/services/ai/decode.test.ts src/server/knowledgeDb.test.ts src/server/retail-knowledge/retailKnowledgeIndex.test.ts src/server/decode/pipeline.test.ts src/stores/scanStore.am2Invariants.store.test.ts src/stores/retailResolve.store.test.ts src/app/api/ai-lookup/decode-corpus.test.ts
npm.cmd run test:ledger
```

- [x] **Step 4: Run repository gates**

```powershell
npm.cmd run proof:local
npm.cmd run test:golden
npm.cmd run test:corpus-drift
npm.cmd run build
```

- [x] **Step 5: Run relevant mock-only browser proof**

```powershell
npx.cmd playwright test e2e/scan.spec.ts
```

- [x] **Step 6: Walk every acceptance criterion and record PASS or exact blocker**

## Cost and safety

- Paid/live API worst case: `$0` because every command is local and offline.
- Subscription agent work: lower-tier scout plus bounded local/Codex review; report token use only at close.
- No production or customer data mutation.
- License status remains unresolved; no generated output is represented as deployable or publishable.

## Rollback

Restore generated serving artifacts from the exact timestamped `C:\tmp` backup. Source changes remain reversible in Git. The raw OFF export is never overwritten.
