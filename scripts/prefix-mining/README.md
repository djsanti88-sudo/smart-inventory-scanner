# scripts/prefix-mining

Offline, deterministic tooling that derives the GS1 prefix -> brand knowledge used by scan-context safety (`src/services/catalog/tirePrefixHints.ts`, `src/products/catalog/derivedPrefixMap.json`). The outputs are committed; these scripts exist to regenerate them and are not wired into `package.json`.

Inputs and outputs live in `data/tire-knowledge/prefixes/` (`tire_prefixes_FINAL.csv` is the validated, tiered table; `ADDITIONS` / `SIBLINGS` / `PROMOTED` are the mined and owner-approved extras). Shared helpers: `scripts/lib/prefix-miner.mjs`.

| Script | Purpose | Cost |
|---|---|---|
| `build-prefix-index.mjs` | Offline GS1 prefix-confidence map from the flat corpus | $0 |
| `mine-tire-prefixes.mjs` | Mines cross-confirmed prefixes into `tire_prefixes_ADDITIONS.csv` + `data/tire-knowledge/mine-report.md` | $0 |
| `mine-tire-siblings.mjs` | Finds corporate-sibling brands sharing a FINAL prefix -> `tire_prefixes_SIBLINGS.csv` | $0 |
| `genTirePrefixHints.mjs` | Generates `src/services/catalog/tirePrefixHints.ts` from the CSVs | $0 |
| `analyze-prefix-db.mjs` | Read-only profiling of the prefix DB | $0 |

Run from the repository root (paths are root-relative).
