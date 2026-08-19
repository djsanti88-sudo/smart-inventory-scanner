# scripts/prefix-mining

Offline tooling that derives the GS1 prefix -> brand knowledge the decode ladder uses (`src/services/catalog/tirePrefixHints.ts`, `src/services/catalog/derivedPrefixMap.json`). The outputs are committed; these scripts exist to regenerate them and are not wired into `package.json`.

Inputs and outputs live in `data/tire-knowledge/prefixes/` (`tire_prefixes_FINAL.csv` is the validated, tiered table; `ADDITIONS` / `SIBLINGS` / `PROMOTED` are the mined and owner-approved extras). Shared helpers: `scripts/lib/prefix-miner.mjs`.

| Script | Purpose | Cost |
|---|---|---|
| `build-prefix-index.mjs` | Offline GS1 prefix-confidence map from the flat corpus | $0 |
| `mine-tire-prefixes.mjs` | Mines cross-confirmed prefixes into `tire_prefixes_ADDITIONS.csv` + `data/tire-knowledge/mine-report.md` | $0 |
| `mine-tire-siblings.mjs` | Finds corporate-sibling brands sharing a FINAL prefix -> `tire_prefixes_SIBLINGS.csv` | $0 |
| `promote-conflicts.mjs` | Writes owner-approved conflict promotions -> `tire_prefixes_PROMOTED.csv` | $0 |
| `genTirePrefixHints.mjs` | Generates `src/services/catalog/tirePrefixHints.ts` from the CSVs | $0 |
| `analyze-prefix-db.mjs`, `eval-prefix-db.mjs` (+ `prefix-db-eval-report.md`) | Read-only profiling / evaluation of the prefix DB | $0 |
| `check-conflicts-gemini.mjs`, `phase05-prefix-cleanup.mjs`, `phase1-enrich-build.mjs`, `validate-prefix-decode.mjs` | Paid Gemini-assisted cleanup / enrichment / validation passes | PAID: gated by `scripts/lib/paidScriptGuard.mjs` (`--live --yes-i-accept-cost` + dev-tooling key), see `docs/COMMANDS.md` |

Run from the repository root (paths are root-relative).
