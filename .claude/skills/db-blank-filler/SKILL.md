---
name: db-blank-filler
description: >-
  Fill blanks and harvest rows in the Scanbin tire corpus, then round-trip a working copy to Turso
  under owner-gated promotion. Use when the owner says "fill database blanks", "enrich tire db",
  "enrich the tire corpus", "fill the missing brand/model/size/MPN", "harvest new tire rows",
  "complete the barcode twins", "db round trip", or "snapshot Turso and enrich". Runs the proven
  cascade (deterministic Lane 0 -> Codex GPT-5.5 subscription batches -> capped Firecrawl fallback)
  with a trusted-host + exact-barcode + blank-only gate, materializes UPC/EAN twins with a primary
  form, and prepares (never auto-applies) a Turso promotion.
---

# db-blank-filler

Enrich, clean, and grow the tire corpus, then stage a Turso round-trip. This skill ORCHESTRATES the
proven tonight pipeline (`scripts/tire-db-repair/*` and `scripts/tire-db-repair/bakeoff/*`) plus a
few new glue scripts under `.claude/skills/db-blank-filler/scripts/`. It never re-implements the
enrichment, trust gate, or validator logic - it invokes those scripts by path.

## Absolute rules (never weaken)
- NEVER write to live Turso, git push, or deploy without EXPLICIT owner approval in the conversation.
- NEVER run a paid stage (Codex batches, Firecrawl) unless the owner asked for a live run.
- NEVER modify the four packaged handoff deliverables directly. Always operate on a WORKING COPY.
  Packaged files live in `backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/`.
- Every DB write goes through the existing trust gate: trusted-host allowlist + exact-barcode
  evidence + blank-only + provenance + audit row. Below-gate rows go to `ENRICHMENT_REVIEW.csv`,
  never silently dropped (TOP-LEVEL LAW parity: nothing vanishes).
- Resolver trust rules (CLAUDE.md): wrong identity is failure, unknown is acceptable. Prefer the
  review queue over a wrong guess. Barcodes and part numbers are TEXT always.
- No em dash or en dash in any user-facing copy or report.
- If any gate fails, FIX THE ROOT CAUSE. Never weaken, skip, or fake a gate to get green.

## Working copy first
Pick a working DB path OUTSIDE the packaged dir (e.g. a scratch/temp copy). Two ways to get one:

- Offline (default): copy the packaged repaired DB.
  `cp backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db <WORK>`
- Live round-trip (read-only snapshot from Turso; needs TURSO_DATABASE_URL / TURSO_AUTH_TOKEN):
  `node .claude/skills/db-blank-filler/scripts/turso_snapshot.mjs <WORK>`
  Exit 2 means no credentials - fall back to the offline copy. This issues SELECT only; it never
  writes Turso.

## Stage order (deterministic-first, paid last)
Run via the driver, which honors `--deadline`, `--pilot`, `--slice`, and skips paid stages unless
`--live`:

```
node .claude/skills/db-blank-filler/scripts/pipeline_driver.mjs --db <WORK> [--deadline 4] \
     [--pilot | --slice 500] [--live] [--dry-run]
```

The driver runs these stages against `<WORK>`:

1. **b5 - deterministic backfill (free)**
   `node scripts/tire-db-repair/bakeoff/b5_deterministic_backfill.mjs <WORK>`
   MPN-from-relationship, GS1-prefix brand, canonical-product copy. Blank-only, idempotent.
2. **twin - barcode twin completion, BOTH directions (free)**
   `node .claude/skills/db-blank-filler/scripts/twin_complete.mjs <WORK>`
   Adds the UPC-A twin for every leading-zero EAN-13 AND the 0-prefixed EAN-13 twin for every
   12-digit UPC-A. Sets `tire_barcode_aliases.is_primary_form` = 1 on the 12-digit UPC-A (PRIMARY,
   owner policy), 0 on its EAN-13 twin. Clones the tires row under the twin barcode so the
   alias<->tire validator invariant stays 1:1. Idempotent; self-checks 0 missing twins.
3. **style - model styling pass (free)**
   `node scripts/tire-db-repair/06_model_styling.mjs <WORK>`
4. **codex - GPT-5.5 batches (PAID, owner-gated)** - see MPN backlog policy below.
5. **firecrawl - capped fallback (PAID, owner-gated)** - only rows Codex left blank and above the
   Firecrawl threshold; below-gate rows to `ENRICHMENT_REVIEW.csv`.
6. **validate - the gate (free)**
   `node scripts/tire-db-repair/05_validate.mjs <WORK>`
   All 16 gates must be GREEN. NOTE: 05_validate.mjs writes `REPAIR_AUDIT.md` and `HASHES_AFTER.txt`
   into the PACKAGED dir regardless of `<WORK>`. When validating a throwaway copy, back up those two
   files first and restore them after, or the packaged audit will reflect the throwaway DB.

Without `--live`, stages 4-5 are reported as skipped and the free stages + validator still run
(a safe dry pipeline you can always run to prove the mechanics).

## New-row harvesting (boss-style xlsx)
Ingest boss workbooks dropped in the harvest folder using the proven reconciler:
`node scripts/tire-db-repair/02_boss_reconciliation.mjs` (text-only cell reads, GTIN validation,
buckets exact/affix/unresolved). NEVER insert unresolved rows - they go to review
(`BOSS_UNRESOLVED_REVIEW.csv`). Alias writes for resolved rows go through
`scripts/tire-db-repair/03_part_number_aliases.mjs` and provenance via `04_provenance.mjs`.

## MPN backlog policy (owner-gated, manual trigger only)
- ~48k MPN blanks are web-only. FIRST invocation: run a **200-row pilot** and STOP with an
  economics report (fills, review delta, batches used, spend, projected full-run cost). Do not
  start a multi-night run until the owner approves the pilot.
  `pipeline_driver.mjs --db <WORK> --pilot --live` (prints the pilot plan; you then launch the
  Codex driver for exactly the pilot rows).
- After pilot approval: consume capped **500-row slices**, one per run
  (`--slice 500`). Priority order: boss brands (nexen/arisun/blackhawk/fortune/falken), then
  inventory-used rows, then valid-barcode rows.
- Codex batches run on the ChatGPT SUBSCRIPTION only (never an OPENAI_API_KEY), ~100 codes/batch,
  blind contract, wrong-answers-penalized, exact-barcode evidence + source URL required. Dispatch
  with `scripts/tire-db-repair/bakeoff/b6_driver.sh <first> <last>`; apply via
  `b6_apply_enrichment.mjs` (the trust gate lives there).

## Owner-approval STOPS (never automatic)
1. **Turso promote.** After the pipeline is GREEN on the working copy, regenerate the staging SQL +
   dry-run diff: `node scripts/tire-db-repair/07_turso_dryrun.mjs <WORK>`. Present the
   `TURSO_DRYRUN_REPORT.md` diff. PROMOTE ONLY on explicit owner approval, in a separate step. The
   skill never runs the promote SQL against live Turso on its own.
2. **MPN pilot -> multi-night.** Stop after the 200-row pilot economics report for owner sign-off.
3. Any git push / deploy / real-data mutation stays owner-gated.

## Time-box and report contract
Every run is time-boxed (default 4h hard stop via `--deadline`). Always end with a report:
- fills per field per source (b5 / twin / codex / firecrawl),
- review-queue delta (`ENRICHMENT_REVIEW.csv` rows added, with reasons),
- remaining blanks per field,
- actual Codex batches + Firecrawl ops used,
- validator verdict (all 16 gates GREEN or the failing gates),
- spend summary: computed floor $X; true spend = provider console (Codex is subscription = $0
  marginal; Firecrawl credits are the only metered cost). Never compute spend from response
  metadata alone.

## Failure handling
- A failed validator or twin gate aborts the pipeline (the driver stops; it never weakens a gate).
- Diagnose the root cause, fix it, re-run. Idempotency means a clean re-run is always safe.
- If Codex quota is exhausted, stop the paid lane and report - do not switch to an API key.

## Smoke tests (prove the glue scripts)
```
node --test .claude/skills/db-blank-filler/scripts/twin_complete.test.mjs \
            .claude/skills/db-blank-filler/scripts/pipeline_driver.test.mjs \
            .claude/skills/db-blank-filler/scripts/turso_snapshot.test.mjs
```
All must pass before trusting a run. They use a tiny in-temp fixture DB and never touch the
packaged deliverable or live Turso.

## Windows / shell notes
Every command in this file is verified to run unchanged from both PowerShell (`cp` is aliased to
`Copy-Item`; forward slashes work fine in Node and PowerShell path arguments) and Git Bash/WSL on
this machine. `<WORK>` paths containing spaces are safe (all scripts here are invoked via an argv
array, never a shell string, so no manual quoting workaround is needed beyond normal shell
quoting of the path itself). All script files in this skill use LF line endings; do not let an
editor or `core.autocrlf` convert them to CRLF.
