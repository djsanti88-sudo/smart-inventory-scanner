# Massive Prefix Table from the Local Tire Corpus (design spec)

Date: 2026-06-25
Status: APPROVED design, pending spec review -> implementation plan
Owner: djsanti88@gmail.com
Scope: tire prefix table only

## 1. Goal

Mine the owner's local ~30k-row tire corpus into a large, cross-confirmed GS1 prefix table so the
decoder - using ONLY the prefix table + AI, never the big corpus - decodes an unknown tire (one not in
any barcode DB) fast, reliably, and with high confidence. This is a pre-publish stress test: prove the
prefix + AI fallback is strong before the big DB ships.

## 2. The "no cheating" architecture (the core rule)

- The big corpus (`data/tire-knowledge/tire_corpus_flat.csv`) is read ONCE, OFFLINE, by the miner to
  derive prefixes. It is NEVER wired into the decode pipeline.
- At runtime the decoder reads ONLY the prefix table (`tirePrefixHints.ts`). It physically cannot look
  up an exact barcode in the big DB, so it must generalize from the brand prefix + AI - the real test.
- The mined prefixes are written to a SEPARATE file, `tire_prefixes_ADDITIONS.csv`. The owner's
  hand-built `tire_prefixes_FINAL.csv` and the big corpus are never modified. No collision.

## 3. Data source (verified)

`data/tire-knowledge/tire_corpus_flat.csv`: 33,878 rows, every row has a `barcode`; columns include
`brand` (clean, lowercase e.g. "falken"), `model`, `size_canonical`, `barcode`, `barcode_type`,
`evidence_level`, `usable_for`. 204 distinct brands; 188 brands have >=2 distinct barcodes (so 188
brands are cross-confirmable to STRONG vs the 45 strong in the table today).

## 4. Components

1. **PrefixMiner** `scripts/mine-tire-prefixes.mjs` (deterministic, $0, no AI):
   - Read the corpus; keep rows with a non-empty `barcode` and `brand`.
   - Normalize each barcode to its GTIN-13 base (zero-pad UPC-A; reuse the same normalization as
     `tirePrefixLookup.normalizeToGtin13`).
   - For each brand, cluster its barcodes by leading-digit GS1 prefix and derive the brand's company
     prefix(es): the dominant shared leading-digit string(s). A brand may legitimately have MORE than
     one prefix (regional blocks) - emit each cluster that has >=2 distinct barcodes.
   - A `(prefix -> brand)` link is STRONG only if >=2 distinct barcodes in the corpus support it
     (the owner's cross-confirmed bar).
   - Shared prefix -> brand FAMILY (multiple brands legitimately on one prefix, e.g. Michelin /
     BFGoodrich on 086699): keep all cross-confirmed brands on that prefix.
   - CONFLICT GUARD: if a derived prefix is unexpectedly short (would swallow many unrelated brands) or
     maps to brands that are not a known corporate family, flag it in the report and do NOT emit it as
     strong (safety over coverage).
   - Output: `tire_prefixes_ADDITIONS.csv` (same columns as `tire_prefixes_FINAL.csv`:
     brand, prefix, prefix_length, region, verification_status=`barcode_checked_crossconfirmed`,
     ingest_tier=`hint_strong`, example_barcode (one real barcode), source_url (a corpus source_url),
     mapping_flag, notes="mined from corpus: N barcodes") + a human-readable `mine-report.md`
     (per prefix: brand(s), barcode count, example codes; plus skipped/conflicted entries with why).

2. **Generator merge** - modify `scripts/genTirePrefixHints.mjs` to read BOTH
   `tire_prefixes_FINAL.csv` AND (if present) `tire_prefixes_ADDITIONS.csv`, merging into one map
   (strong beats weak on a duplicate brand+prefix; additive; dedupe). The owner's CSV is read-only.

3. **Safety + sanity gate** (after regenerate):
   - SANITY: the miner's derived prefix for known brands MUST match the existing strong table
     (Michelin->086699, Cooper->029142, Falken->0848983, etc.). A mismatch means the derivation logic
     is wrong - fail the run.
   - SAFETY: run the poison/eval/corroboration suites (`src/services/ai/decode*`, `src/eval`,
     `src/services/tire`) -> false-auto-count stays 0; repoint any weak-tier example test whose prefix
     became strong (as done for Nexen->Nokian).

4. **Validation harness** `scripts/validate-prefix-decode.mjs` (mini models only):
   - Hold out a sample of corpus tires (and/or use fresh barcodes NOT in the corpus). For each, scan
     through the LIVE pipeline (`mode:"decode-deep"`, `scanContext:"tire"`) with the big corpus NOT
     consulted - only the mined prefix table + Gemini Flash. Measure: % auto-verified, p50/p95 latency,
     est cost. Write `prefix-decode-validation.json` + a short report.
   - Expectation: verify rate materially above the ~30% baseline (which used 45 strong prefixes);
     false-auto-count 0; cost under budget (Gemini Flash, ~1 cent per unknown tire).

## 5. Budget

- Build the prefix table: **$0** (deterministic; brands already clean; no AI).
- Validation run (50-100 unknown tires): **~$0.10-$0.50** (Gemini Flash grounded call + page-fetch per
  tire; Firecrawl only on fallback).
- Production, ongoing: ~1 cent per UNKNOWN tire scan; known/prefix-anchored tires resolve at $0.

## 6. Acceptance criteria

1. `tire_prefixes_ADDITIONS.csv` produced with cross-confirmed strong prefixes for ~150-188 brands,
   plus a `mine-report.md`. The owner's `tire_prefixes_FINAL.csv` and the big corpus are byte-unchanged.
2. The miner's derived prefixes for the existing 45 strong brands MATCH the current table (sanity).
3. `genTirePrefixHints.mjs` merges FINAL + ADDITIONS; regenerated `tirePrefixHints.ts` contains the new
   strong prefixes; no duplicate/garbage entries.
4. Poison/eval/corroboration suites green; false-auto-count = 0.
5. A live validation run on held-out/unknown tires shows verify rate well above 30%, p50 latency in the
   low seconds, false-count 0, mini-model cost within budget. Numbers captured in the validation report.
6. The decoder reads ONLY the prefix table at runtime - confirm no code path consults the big corpus.

## 7. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Wrong GS1 prefix length derived | Validate against the 45 known-strong brands (must match); require >=2 cross-confirming barcodes; conflict guard on too-short prefixes |
| A brand uses multiple GS1 prefixes (regional) | Emit each barcode cluster with >=2 codes as its own prefix |
| A short prefix swallows unrelated brands (false family) | Conflict guard: flag + skip suspicious short prefixes; keep only clear corporate families |
| Erroneous rows in the corpus | Cross-confirm >=2 distinct barcodes; optionally restrict to rows whose `evidence_level`/`usable_for` indicate a verified source |
| The big corpus accidentally wired into decode | Hard rule + acceptance check (6); miner is a standalone offline script, decoder imports only the prefix table |
| A promoted prefix breaks a weak-tier example test | Repoint that test to a still-weak prefix (precedent: Nexen->Nokian) |

## 8. Out of scope

- Editing `tire_prefixes_FINAL.csv` (owner-owned) or the big corpus.
- Wiring the big corpus into the decoder (forbidden by the no-cheating rule).
- The flotation/commercial size-parsing fix (owner deferred it).
- Publishing the big DB (separate; this proves the fallback first).
