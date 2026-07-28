# Tire DB Repair + Enrichment Bakeoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair `02_ENRICHMENT_STAGE_2_rich.db` (part-number joins, boss merge, provenance, model styling), run a 4-lane enrichment bakeoff on 30 codes, and produce all handoff deliverables - with zero writes to live Turso.

**Architecture:** Node scripts (better-sqlite3, already a repo dependency) under `scripts/tire-db-repair/`, operating on a working copy of the rich DB. Deterministic repair (Workstream A) and the bakeoff (Workstream B) run in parallel; model styling (C) runs after A. Every script is idempotent and every write is audited.

**Tech Stack:** Node 20+ ESM (`.mjs`), better-sqlite3, exceljs (repo dep) for xlsx, Claude subagents for web lanes, Codex CLI (ChatGPT OAuth) for Lane 3.

## Global Constraints

- NEVER modify the four packaged files in `backups/claude-tire-db-handoff-2026-07-28/` (verify SHA-256 before and after; expected hashes are in `CLAUDE_HANDOFF.md`).
- All outputs go to `backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/` (create it).
- Working DB: `repair-2026-07-28/REPAIRED_TIRE_DATABASE.db` (copy of the rich DB).
- Never resolve ambiguity with `LIMIT 1` or arbitrary row order. Multiple candidates = conflict record.
- Boss workbook rows are 100% trusted truth (owner decision 2026-07-28) - merge, don't verify.
- Enrichment write gate: single trusted source (manufacturer/major-distributor allowlist + exact barcode match) auto-writes with provenance; anything weaker goes to review CSV. Never invent data.
- Model display styling is manufacturer-official (`Wildpeak A/T3W`); `model_normalized` matching keys never change.
- No live Turso write, no push, no deploy. Paid calls only within the approved 30-code bakeoff.
- Barcodes/part numbers are TEXT everywhere. Preserve raw strings exactly.
- No em/en dashes in any user-facing or report copy.

---

### Task A1: Working copy, hash record, RED proof

**Files:**
- Create: `scripts/tire-db-repair/00_setup_and_red_proof.mjs`
- Create (output): `repair-2026-07-28/HASHES_BEFORE.txt`, `repair-2026-07-28/RED_PROOF.md`

**Interfaces:**
- Produces: `REPAIRED_TIRE_DATABASE.db` working copy; `openDb(path)` convention: every later script takes the DB path as argv[2] defaulting to the working copy.

- [ ] **Step 1:** Script computes SHA-256 of the 4 packaged files (crypto.createHash over stream), writes `HASHES_BEFORE.txt`, and FAILS if they differ from the handoff table values (`1AF5153A...` etc. - copy all four from `CLAUDE_HANDOFF.md`).
- [ ] **Step 2:** Copy `02_ENRICHMENT_STAGE_2_rich.db` to `repair-2026-07-28/REPAIRED_TIRE_DATABASE.db` (skip if exists and `--force` not passed - idempotent).
- [ ] **Step 3:** RED proof queries against the working copy, written to `RED_PROOF.md`:
  - `PRAGMA integrity_check` (expect `ok`)
  - counts: tires (expect 82640), tire_part_numbers (29173), tire_barcode_aliases (82640), canonical_tire_products, stage2_enrichment_audit (0), tire_product_part_number_aliases (0)
  - `SELECT count(*) FROM tire_part_numbers p JOIN tires t ON t.canonical_product_uid = p.canonical_product_uid` (expect 0 - THE broken join)
  - same join against `canonical_tire_products` (expect 0)
  - 20 sample part-number lookups (4 per boss brand: Nexen, Arisun, Blackhawk, Fortune, Falken) using the runtime semantics from `src/server/tire-knowledge/tireKnowledgeIndex.ts` (read it first; replicate its normalize + resolve steps in SQL) - all must return no tire (RED).
- [ ] **Step 4:** Run `node scripts/tire-db-repair/00_setup_and_red_proof.mjs`, confirm RED_PROOF.md shows 0/29173. Commit scripts + RED_PROOF.md (never commit the .db - check `.gitignore` covers `backups/` or add output folder to it).

### Task A2: Part-number UID repair

**Files:**
- Create: `scripts/tire-db-repair/01_repair_part_number_uids.mjs`
- Create (output): `repair-2026-07-28/PART_NUMBER_CONFLICTS.csv`, `repair-2026-07-28/UID_MAPPING_AUDIT.csv`

**Interfaces:**
- Consumes: working copy from A1; `01_PROCESS_MERGED_pre_canonical.db` read-only.
- Produces: repaired `tire_part_numbers.canonical_product_uid`; audit CSVs. Later tasks rely on the join `tire_part_numbers -> tires` being GREEN.

- [ ] **Step 1:** ATTACH the pre-canonical DB read-only. Build the mapping in one deterministic pass:

```sql
-- old UID -> set of stable IDs via shared barcodes
CREATE TEMP TABLE uid_map AS
SELECT old.canonical_product_uid AS old_uid,
       COUNT(DISTINCT alias.canonical_product_id) AS target_count,
       MIN(alias.canonical_product_id) AS only_target -- valid ONLY when target_count = 1
FROM pre.tires old
JOIN main.tire_barcode_aliases alias ON alias.barcode = old.barcode
GROUP BY old.canonical_product_uid;
```
  (Adapt actual column names after inspecting both schemas - inspect first, do not assume.)
- [ ] **Step 2:** Classify every DISTINCT old UID referenced by `tire_part_numbers`: `migrated` (target_count=1), `conflict` (>1), `orphan` (no row). Write all three classes to `UID_MAPPING_AUDIT.csv`; conflicts and orphans also to `PART_NUMBER_CONFLICTS.csv` with the candidate stable IDs listed.
- [ ] **Step 3:** Inside one transaction, UPDATE only `migrated` rows. Print before/after joined counts.
- [ ] **Step 4:** GREEN gate inline: total part-number rows still 29173; joined-to-tires count + conflict-quarantined count = 29173; joined rows also join `canonical_tire_products`. Script exits nonzero if any gate fails.
- [ ] **Step 5:** Re-run the 20 runtime lookups from A1 - all migrated brands must now resolve. Rerun the whole script a second time to prove idempotency (same counts, no double-update). Commit.

### Task A3: Boss reconciliation + trusted merge

**Files:**
- Create: `scripts/tire-db-repair/02_boss_reconciliation.mjs`
- Create (output): `repair-2026-07-28/BOSS_ROW_RECONCILIATION.csv` (all 6990 rows), `repair-2026-07-28/BOSS_UNRESOLVED_REVIEW.csv` (~637 rows)

**Interfaces:**
- Consumes: repaired DB from A2; `03_BOSS_SOURCE_BARCODES.xlsx` (read with exceljs, ALL cells as text - use `cell.text`, never `cell.value` numerics).
- Produces: reconciliation CSVs; boss-truth fills written into `tires` blanks; provenance rows tagged `boss_source` (schema defined here, formalized in A5): `provenance(product_id, barcode, source_name, source_ref, sheet, row, batch_id, imported_at, evidence_level)`.

- [ ] **Step 1:** Load all 6990 rows preserving raw barcode text. For each row compute: normalized candidates (trim, strip spaces/dashes, safe zero-pad only when resulting GTIN check digit is valid), GTIN validity + level (GTIN-8/UPC-A/EAN-13/GTIN-14), normalized part-number variants (digit-only core, distributor-affix strip: leading `BH`/`F` etc. only when remainder matches a known core).
- [ ] **Step 2:** Match in priority order: exact barcode -> exact part number -> distributor-affix core + brand + size agreement. Record match_method and evidence per row. Expected buckets: 6118 exact, ~235 affix, ~637 unresolved (compare to handoff numbers; investigate any drift, don't force it).
- [ ] **Step 3:** For matched rows, fill blank `brand`/`model`/`size`/`manufacturer_part_number` in `tires` from boss values (blank-only fill; NEVER overwrite non-blank), insert provenance rows, log every write to `remaining_blank_fill_audit` with `trust_color='green'`, `action='boss_truth_fill'`.
- [ ] **Step 4:** Special case Sheet2 row 8: GTIN-14 `30029885620210` goes to `BOSS_UNRESOLVED_REVIEW.csv` with status `packaging_needs_quantity` - do NOT store it as any alias until package level AND quantity are confirmed (handoff gate). Reconciliation CSV records it as `packaging code`.
- [ ] **Step 5:** Write both CSVs with every handoff-required column (sheet, row, raw barcode, candidates, validity, part number variants, matched stable ID, method, evidence, final status). Gate: CSV row count = 6990 exactly. Idempotency: re-run changes nothing. Commit.

### Task A4: Part-number alias table

**Files:**
- Create: `scripts/tire-db-repair/03_part_number_aliases.mjs`

**Interfaces:**
- Consumes: repaired DB from A3 (needs boss part numbers present).
- Produces: populated `tire_product_part_number_aliases(canonical_product_id, alias_value, alias_normalized, alias_kind, evidence, created_at)` with kinds: `canonical`, `distributor_affix`, `format_variant`, plus conflict rows in `PART_NUMBER_CONFLICTS.csv` (append section 2).

- [ ] **Step 1:** Inspect the existing empty table schema; extend only if required (document any ALTER).
- [ ] **Step 2:** Generate aliases: for every part number, digit-only + affix variants seen in boss data or `process_merge_audit` (`1600974`/`BH1600974`, `28847017`/`F28847017`); decimal-form variants only when the same barcode + product identity corroborates.
- [ ] **Step 3:** Reclassify the 1095 `part_number_value_conflict` green events + 39 UID conflicts from `process_merge_audit` into: confirmed canonical / confirmed alias / safe affix alias / true conflict (review). Canonical MPN is never overwritten by a distributor variant.
- [ ] **Step 4:** Gate: no duplicate `alias_normalized` pointing at different stable products without a conflict record; every alias joins to a live product. Commit.
- [ ] **Step 5:** Wire the runtime to USE the alias table (handoff: "populate and use"): in `src/server/tire-knowledge/tireKnowledgeIndex.ts`, extend the part-number resolution to fall back to `tire_product_part_number_aliases` (normalized match -> canonical product) after the existing `tire_part_numbers` miss, for BOTH the local-SQLite and Turso paths. Ambiguous alias (multiple products) returns no match, never guesses. Add unit tests with a fixture DB proving: affix alias resolves, ambiguous alias does not, existing exact lookups unchanged. `npx vitest run` on the touched test files.

### Task A5: Provenance + source_count

**Files:**
- Create: `scripts/tire-db-repair/04_provenance.mjs`
- Create (output): `repair-2026-07-28/PROVENANCE_GAPS.csv`

**Interfaces:**
- Consumes: repaired DB from A3/A4.
- Produces: `provenance` table (schema from A3 Interfaces), `source_count` derived, `stage2_enrichment_audit` populated with this repair batch's actions.

- [ ] **Step 1:** Create `provenance` if missing. Backfill known origins: boss rows (from A3), rows present in live-Turso snapshot lineage if identifiable, corpus-import batches identifiable from `process_merge_audit`. Evidence levels: `boss_source` > `import_audit` > `unknown`.
- [ ] **Step 2:** `UPDATE tires SET source_count = (SELECT count(*) FROM provenance p WHERE p.barcode = tires.barcode)`. Rows with zero provenance go to `PROVENANCE_GAPS.csv` (honest gap measurement - expect a large number; that is the truthful state, do not fabricate).
- [ ] **Step 3:** Insert one `stage2_enrichment_audit` row per repair action batch (A2 migration, A3 fills, A4 aliases) with counts and timestamps. Commit.

### Task A6: Validator + GREEN proof

**Files:**
- Create: `scripts/tire-db-repair/05_validate.mjs`
- Create: `scripts/tire-db-repair/validate.test.mjs` (run via `node --test`)
- Create (output): `repair-2026-07-28/REPAIR_AUDIT.md`, `repair-2026-07-28/HASHES_AFTER.txt`

**Interfaces:**
- Consumes: fully repaired DB.
- Produces: exit-code validator used by every later run; `REPAIR_AUDIT.md` final report.

- [ ] **Step 1:** Validator fails (nonzero exit) on ANY of: integrity_check != ok; orphan part-number mapping in the ACTIVE table (quarantined rows live in `tire_part_numbers_quarantine` and active+quarantine must sum to 29173); barcode alias without tire row; tire without barcode alias; alias/tire stable-ID disagreement; duplicate normalized part-number keys -> different products without conflict record; any of the 5316 valid boss GTINs missing; key counts below baseline (82640 tires, 29173 part-number rows across active+quarantine); packaged input hash drift.
- [ ] **Step 2:** `node --test` suite proving: exact barcode lookup, exact part-number lookup, safe affix lookup (via the alias table), ambiguous core does NOT auto-resolve, UPC/EAN leading-zero alias behavior, GTIN-14 packaging behavior (row 8 case: NOT resolvable as a unit tire), one lookup per boss brand. Every lookup test runs the explicit two-step runtime path (part-number key -> canonical_product_uid, then tires by UID as a separate query), matching `tireKnowledgeIndex.ts` semantics on both backends.
- [ ] **Step 3:** Run validator + tests, write `REPAIR_AUDIT.md` (RED vs GREEN table, all counts, quarantine list, drift notes), write `HASHES_AFTER.txt` proving packaged inputs unchanged and recording the repaired DB hash. Commit.

### Task B1: Bakeoff sample + harness

**Files:**
- Create: `scripts/tire-db-repair/bakeoff/build_sample.mjs`
- Create (output): `repair-2026-07-28/bakeoff/sample.json`, `repair-2026-07-28/bakeoff/answer_key.json` (answers kept separate from lane inputs)

**Interfaces:**
- Produces: `sample.json`: array of 30 `{id, barcode, known_fields, missing_fields}` (10 blank-brand, 10 blank-mpn, 10 blank-size). ~15 have hidden truth in `answer_key.json` sourced from boss/pre-canonical data (fields blanked in sample but known); 15 genuinely unknown. Lane result format every lane must emit: `{id, lane, fills: {field: value}, source_url, source_host, evidence_quote, latency_ms, cost_estimate, confidence}`.

- [ ] **Step 1:** Query the working DB for candidate rows per category; for the answer-key half, pick rows whose truth is recoverable from boss/pre-canonical joins; blank those fields in `sample.json`. Write both files. Commit script (not outputs).

### Task B2: Lane 0 - deterministic (GS1 prefix + internal cross-reference)

**Files:**
- Create: `scripts/tire-db-repair/bakeoff/lane0_deterministic.mjs`
- Create (output): `repair-2026-07-28/bakeoff/results_lane0.json`

**Interfaces:**
- Consumes: `sample.json`; repo's existing prefix data (`src/services/catalog/brandPrefixGeneral.ts` / `prefixFirewall.ts` - read for the prefix->brand map or its data source).
- Produces: `results_lane0.json` in the lane result format; `solved_ids` list that later lanes may skip.

- [ ] **Step 1:** For each sample row: GS1 company prefix -> brand candidate (reuse the repo's prefix map; if it is TS-embedded, extract via a small parse or re-export - document approach). Size/MPN via internal cross-reference: same prefix + same MPN pattern family elsewhere in the DB, sibling-row interpolation ONLY reported as `confidence: low`, never as a fill.
- [ ] **Step 2:** Emit results. No writes to the DB. Commit script.

### Task B3: Lanes 1-3 - live enrichment runs (subagent-driven)

**Files:**
- Create (output): `repair-2026-07-28/bakeoff/results_lane1.json` (WebSearch/Exa), `results_lane2.json` (Firecrawl), `results_lane3.json` (Codex GPT-5.5 web)

**Interfaces:**
- Consumes: `sample.json` (NEVER `answer_key.json` - lanes are blind), lane result format from B1.
- Produces: three results files.

- [ ] **Step 1:** Lane 1: dispatch a subagent (Sonnet) that, per code, runs WebSearch/Exa queries (`"<barcode>" tire`, `site:` variants), extracts brand/model/size/MPN from result snippets + one WebFetch of the best hit, records source host + quote. Timebox ~2 min/code.
- [ ] **Step 2:** Lane 2: subagent using Firecrawl skill (`firecrawl:firecrawl-search` then scrape best hit with structured extraction schema `{brand, model, size, mpn, barcode_on_page}`). Record credit usage per call.
- [ ] **Step 3:** Lane 3: Codex rescue subagent (ChatGPT OAuth verified) given the 30 codes in one batch prompt, asked to web-research each and return the result format with source URLs. One Codex run, not 30.
- [ ] **Step 4:** All three run in PARALLEL (independent). Each writes its results JSON. No DB writes.

### Task B4: Scorecard + bakeoff report

**Files:**
- Create: `scripts/tire-db-repair/bakeoff/score.mjs`
- Create (output): `repair-2026-07-28/ENRICHMENT_BAKEOFF_REPORT.md`

**Interfaces:**
- Consumes: all 4 results files + `answer_key.json`.
- Produces: per-lane scorecard and the recommended cascade; owner decision point for the scaled run.

- [ ] **Step 1:** Score per lane: coverage (fields filled / fields asked), accuracy on answer-key rows (exact-match after normalization; size compared structurally e.g. 265/70R17), WRONG-ANSWER RATE (filled but != truth - the killer metric), mean latency, est. cost per successful fill, trusted-host share.
- [ ] **Step 2:** Report ranks lanes, recommends the cascade (Lane 0 -> winner -> fallback), estimates full-run cost for the real blank population (1614 brand, 48145 mpn, 1623 size - with the note that mpn at 48k scale is only economic via the winner's cheapest mode). Ends with explicit "awaiting owner approval for scaled run". Commit script + report.

### Task C1: Model styling cleaner

**Files:**
- Create: `scripts/tire-db-repair/06_model_styling.mjs`
- Create: `scripts/tire-db-repair/model_styling_rules.json`
- Create: `scripts/tire-db-repair/model_styling.test.mjs`

**Interfaces:**
- Consumes: repaired DB (post-A3 so boss fills are styled too).
- Produces: new column `tires.model_display` (ALTER TABLE ADD COLUMN, blank-safe); rules JSON `{brand, slug_pattern, display}`; audit rows in `remaining_blank_fill_audit` (`action='model_display_styling'`).

- [ ] **Step 1:** Write failing tests first: `wildpeak_a_t3w -> Wildpeak A/T3W`, `wildpeak_h_t02 -> Wildpeak H/T02`, `open_country_a_t_iii -> Open Country A/T III`, plus fallback title-case for unknown slugs (`roadian_gtx -> Roadian GTX`? No: fallback is plain title case `Roadian Gtx` is WRONG - uppercase 2-4 letter tokens that match ^[a-z]{2,4}[0-9]*$ heuristics; test `nfera_su1 -> N'Fera SU1` only if a rule exists, else `Nfera SU1`).
- [ ] **Step 2:** Build `model_styling_rules.json` for the top ~100 models by row count (query `GROUP BY brand, model ORDER BY count DESC`); curate manufacturer-official styling for the five boss brands + majors (Michelin, Goodyear, Bridgestone, Continental, Toyo, Falken, Nexen, Kumho, Hankook). Deterministic fallback for the tail: tokenize slug, join designation letter-groups with `/` only when rule-listed, else title case + uppercase short alphanumeric tokens; mark fallback rows `trust_color='yellow'` in audit.
- [ ] **Step 3:** `model_normalized` untouched (gate: `SELECT count(*)` of changed model_normalized = 0). Run tests, run script, spot-check 30 random rows in the audit table. Commit.

### Task D1: Turso dry-run report (prepare only)

**Files:**
- Create: `scripts/tire-db-repair/07_turso_dryrun.mjs`
- Create (output): `repair-2026-07-28/TURSO_DRYRUN_REPORT.md`

**Interfaces:**
- Consumes: validated repaired DB; read-only Turso credentials ONLY if already configured in env (else compare against the handoff's recorded live counts and label the report `offline-snapshot mode`).
- Produces: staging-table migration SQL + dry-run diff report + rollback plan. NO EXECUTION.

- [ ] **Step 1:** Generate idempotent staging SQL (CREATE TABLE staging_*, INSERT batches) to files, not to Turso.
- [ ] **Step 2:** Diff report: expected +4203 tire keys, +4422 part-number keys, all 78437 live tire keys preserved, all 24751 live part-number keys preserved, operational tables untouched. Rollback: staging drop + backup restore steps. Ends "requires explicit owner approval to execute". Commit.

---

## Self-review notes

- Spec coverage: A1-A6 cover handoff sections 1-5, 7, 8; B1-B4 cover section 6 + the bakeoff; C1 covers model cleaning; D1 covers section 9. Deliverables list fully mapped.
- Exact counts from the handoff are embedded as gates (82640, 29173, 6990, 6118, 235, 637, 5316, 4203, 4422).
- Parallelism: A-track sequential within itself (A1->A6); B-track parallel to A (works on its own read snapshot + writes nothing to the DB); C1 after A3; D1 after A6 and B is not a dependency.
