# Tire DB repair + enrichment bakeoff design (2026-07-28)

Owner-approved design for repairing `02_ENRICHMENT_STAGE_2_rich.db`, filling blanks via the
most efficient enrichment lane, and cleaning model names. Companion to the packaged handoff
`backups/claude-tire-db-handoff-2026-07-28/CLAUDE_HANDOFF.md`, which remains the detailed
requirements source. This spec records the owner decisions taken today.

## Owner decisions (2026-07-28)

1. **Sequencing:** Workstreams run in parallel (deterministic repair + enrichment bakeoff).
2. **Boss rows are 100% trusted ground truth.** No verification needed; merge them as truth.
   They also serve as the hidden answer key for scoring the bakeoff lanes.
3. **Bakeoff budget:** 30 test codes x all lanes approved (Firecrawl credits + Codex ChatGPT
   quota + free WebSearch/Exa). Report actual usage after.
4. **Write gate:** single trusted source is enough - a manufacturer or major-distributor page
   on a trusted-host allowlist with an exact barcode match auto-writes, with provenance.
   Anything weaker goes to a review CSV. Never invent data; unknown beats wrong.
5. **Model cleaning format:** manufacturer official styling (`Wildpeak A/T3W`, `Open Country
   A/T III`) via per-brand rules. Matching keys (`model_normalized`) stay normalized
   lowercase; the styled form is the display value.

## Workstream A - Deterministic repair (no web, free)

Work on a working copy; packaged inputs never modified; before/after SHA-256 recorded.

1. RED proof: integrity check, all table counts, the 0-of-29,173 part-number join failure,
   20+ representative failing runtime lookups, baseline hashes.
2. UID repair: build old-UID -> barcode(s) -> stable-ID mapping using
   `01_PROCESS_MERGED_pre_canonical.db` as evidence. Classify each old UID:
   exactly-one target (migrate), multiple targets (conflict, review file), none (orphan,
   review file). Never LIMIT 1 / arbitrary order.
3. Boss merge as truth: 6,118 exact-linked + 235 affix-corroborated rows write
   brand/model/size/part-number into blanks with provenance `boss_source`. The 637
   unresolved rows go to `BOSS_UNRESOLVED_REVIEW.csv` - never inserted to reach coverage.
   Sheet2 row 8 GTIN-14 stored only as a packaging alias with level/quantity metadata.
4. Part-number aliases: populate `tire_product_part_number_aliases` for distributor-affix
   variants (`1600974`/`BH1600974`, `28847017`/`F28847017`); canonical MPN never overwritten
   by a distributor variant. Split the 1,095 value-conflict events into confirmed canonical /
   confirmed alias / safe affix alias / true conflict.
5. Provenance: normalized provenance records (product ID, barcode, source, sheet/row, batch,
   timestamp, evidence level); `source_count` derived from them. `stage2_enrichment_audit`
   populated or replaced with documented equivalent.
6. Validator: repeatable script failing on every condition in handoff section 8, plus focused
   lookup tests across all five boss brands. GREEN gate per handoff section 2.

## Workstream B - Enrichment bakeoff (30 codes x 4 lanes)

Sample: 10 blank-brand + 10 blank-MPN + 10 blank-size rows. Half have hidden known answers
(from boss/pre-canonical data) for accuracy scoring; half genuinely unknown.

- **Lane 0 (deterministic, free):** GS1 company-prefix -> brand inference + internal
  cross-referencing (e.g. `6921109...` prefix family). Runs first; solved rows are excluded
  from paid lanes.
- **Lane 1:** WebSearch / Exa (free-tier web search).
- **Lane 2:** Firecrawl search + scrape with structured extraction (credits).
- **Lane 3:** Codex GPT-5.5 with web, ChatGPT subscription lane (OAuth, never API key).

Scorecard per lane: coverage %, accuracy vs hidden truth, wrong-answer rate (killer metric),
cost per successful fill, latency, automation-friendliness. Winner (or winning cascade)
becomes the scaled pipeline; afterward it is packaged as a reusable `db-blank-filler` skill.

Scaled run: cost-ordered cascade exactly like the decode ladder - Lane 0 first, then the
winner, stopping at first trusted answer. All writes pass the single-trusted-source gate and
create provenance records. Everything else -> `ENRICHMENT_REVIEW.csv`.

## Workstream C - Model/description cleaning (deterministic, no AI)

- Curated per-brand styling rules table (slug -> official style) for high-frequency models;
  deterministic fallback (title case + designation patterns like `a_t3w` -> `A/T3W`) for the
  tail, flagged lower-confidence in the audit.
- Adds/fills a styled display value; `model_normalized` matching keys unchanged so no lookup
  behavior changes. Every change audited (old value, new value, rule ID).

## Deliverables (new subfolder next to the handoff)

`REPAIRED_TIRE_DATABASE.db`, `REPAIR_AUDIT.md`, `BOSS_ROW_RECONCILIATION.csv`,
`BOSS_UNRESOLVED_REVIEW.csv`, `PART_NUMBER_CONFLICTS.csv`, `PROVENANCE_GAPS.csv`,
`ENRICHMENT_BAKEOFF_REPORT.md`, `ENRICHMENT_REVIEW.csv`, idempotent scripts, focused tests,
Turso dry-run report, before/after hashes.

## Hard limits

No live Turso write, push, deploy, or production change. Paid calls limited to the approved
bakeoff sample until the owner approves the scaled run based on the bakeoff report.
