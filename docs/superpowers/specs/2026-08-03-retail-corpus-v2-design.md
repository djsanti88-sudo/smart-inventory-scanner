# Retail Corpus V2 Design

## Approval basis

The owner reviewed the completed 4,047,273-row audit and explicitly directed implementation: make the database materially better, fill and organize as much as evidence permits, fix errors row by row, and return only after all relevant gates are green. This document turns that approved direction into an implementation contract without widening any production, paid API, deploy, or push permission.

## Goal

Build an evidence-first retail corpus that is substantially more complete and auditable while preserving the current fast four-field runtime lookup and the rule that unsupported identity stays unknown. The enriched JSONL is the local evidence store; this phase does not create a duplicate curation database.

## Measurable success

- Preserve one unique, checksum-valid GTIN per known serving row.
- Preserve at least the current 4,047,273 known-name source candidates before high-precision quarantine.
- Account for every scanned source observation and retain one deterministic projection per checksum-valid GTIN, with duplicate conflicts recorded rather than silently won.
- Retain alternate names, raw categories, country, quantity, images, source URL, source timestamps, source actor fields, export fingerprint, and row payload hash when present.
- Keep `product_name` source precedence strict: only `product_name` can populate the known serving name. `abbreviated_product_name` and `generic_name` are evidence only.
- Recover nameless source rows with brand or category into `partial`; never return them through normal known retail lookup.
- Normalize exact category sentinels only in the serving projection while preserving raw values in evidence.
- Preserve the current serving quarantine contract in this phase. Record contextual markers separately for review; no previously rejected row is promoted without a barcode-level reviewed allowlist.
- Make barcode uniqueness a database constraint, not only an observed property.
- Rebuild the generated retail JSON and slim knowledge DB locally with integrity, count, drift, and regression gates green.

## Architecture

### 1. Raw export to enriched retained source

`data/retail-knowledge/scripts/process_off.py` remains the streaming boundary for the 1.2 GB compressed Open Food Facts export. It will retain the current fields plus exact source evidence. Source strings are stored as immutable `*_raw` values; any normalized projection is separate:

- alternate and descriptive labels: `abbreviated_product_name`, `generic_name`
- brand evidence: `brands`, `brands_en`, `brand_owner`
- taxonomy evidence: `main_category`, `main_category_en`, `categories`, `categories_en`, `food_groups_en`, `pnns_groups_1`, `pnns_groups_2`
- context: `quantity`, `countries_en`, `image_url`, `image_small_url`
- provenance: `url`, `creator`, `owner`, `last_modified_by`, created/modified/updated timestamps
- quality: `completeness`, `unique_scans_n`, `data_quality_errors_tags`, `states_tags`
- reproducibility: `_source`, `_source_export_sha256`, `_payload_sha256`

The processor writes a versioned output beside the current intermediate and promotes it only after a complete scan succeeds. It also emits a receipt containing source SHA-256, header SHA-256, raw rows scanned, malformed/invalid rows, checksum-valid observations, unique retained GTINs, identical duplicates, conflicting duplicates, output rows, and output SHA-256. Duplicate observations are canonicalized independently of source order: each source-only raw record is canonical-JSON hashed; observations are sorted by that hash; the lexicographically first canonical observation supplies the display copy; and a sorted `_duplicate_observations` array retains every observation hash plus every raw field whose value differs. Non-conflicting duplicate evidence is therefore preserved without an arbitrary first-row winner. Any disagreement in identity-bearing primary name, brand assertions, or category assertions marks the GTIN for review and excludes it from serving. The raw export remains unchanged.

### 2. Deterministic classification

One fixture-tested build-time contract classifies each unique retained GTIN:

- `known`: exact checksum-valid GTIN, usable primary `product_name`, no duplicate or variant-family identity conflict, and no existing hard quarantine signal. In this document `known` means eligible for a database-backed runtime suggestion; it never means app-verified identity.
- `review`: every non-quarantined row that is not `known`, including missing/short primary names with or without other assertions and every duplicate/variant-family identity conflict. Review reasons distinguish `partial_evidence`, `unidentified`, `duplicate_conflict`, and `variant_conflict`.
- `quarantined`: exact blocklisted/degenerate barcode or an exact poison placeholder value

The existing serving quarantine contract is frozen byte-for-behavior for this phase. It consists of exact barcode values `012345678905`, `4006381333931`, `5901234123457`, `0012345670121`, `0012345674020`, and `0012345674037` checked across the existing zero-padding variants; all-zero, all-same-digit, `0123456789012`, and `1234567890128` degenerate shapes; and the existing whole-word name/brand expression `test|fakeer|fake ?wine|dummy|sample product|placeholder|brandtest|shopidoo`. Contextual marker matches are additionally recorded as review flags, but still remain excluded from serving. Any future relaxation requires an explicit barcode allowlist and a complete dequarantine diff.

### 3. Slim serving projection

`retailKnowledge.generated.json` remains backward compatible:

```text
barcode -> [product_name, brand, category]
```

Only `known` rows enter this projection. Brand and category use exact source precedence, sentinel filtering, whitespace collapse, and HTML entity decoding. Raw strings remain in the enriched versioned JSONL, the sole raw-evidence store. Encoding repair is deferred unless separately proven against source-preserving fixtures and a reviewed GTIN diff.

The local `retail` SQLite table remains the runtime lookup target and stays slim. `barcode` becomes the primary key. Existing local/Turso readers continue returning the same `RetailLookupResult` shape.

### 4. Review and drift receipts

The build emits compact local JSONL review receipts for `partial`, `quarantined`, duplicate-conflict, and changed-serving rows. Each receipt includes only barcode, status/reason, source payload hash, and source URL/line pointer. A machine-readable projection diff enumerates added, removed, renamed, brand-changed, category-changed, newly quarantined, and dequarantined GTINs. Dequarantined must remain empty in this phase.

### 5. Quality ledger

The generator meta file records counts for raw observations, duplicate classes, every classification, fallback, normalization, quarantine reason, missing field, and source-evidence coverage. Metrics must reconcile:

```text
known + review + quarantined = unique retained GTINs
```

Conflict counters may not remain hard-coded zero. If no competing assertion exists, the metric is explicitly `not_measured_single_source` rather than a fabricated numeric zero.

## Error handling

- Invalid JSON rows and invalid GTINs are counted and excluded from serving, with no partial output promotion.
- A failed source scan leaves the prior retained JSONL untouched.
- Each generated file is atomically replaced on its own after every versioned artifact has been built and SHA-256 checked. A generation receipt records the matching hashes. The fixed legacy runtime paths do not support transactional multi-file replacement, so no cross-file atomicity is claimed: a Windows rename/lock failure triggers best-effort restoration from the exact backup and a hard failure. After promotion, both the fixed-path DB and a fresh decompression of the fixed-path gzip must independently match the validated DB SHA-256, retail count, and integrity result before success; the gzip is a runtime fallback when the uncompressed DB is absent.
- A disk/memory preflight runs before backups or writes. It requires free space greater than two enriched intermediates plus two serving JSON/DB/gzip sets and a 25% margin, and runs the full Node projection with an explicit heap limit. Failure stops before writing.
- The full build snapshots the exact tire JSON input, records its SHA-256, and refuses promotion if the original changes before completion.
- The full knowledge build is invoked fail-closed with retail required and exact retail count matching the serving meta.
- Optional source columns are retained when present and counted as missing when absent; no missing optional source field blocks serving projection or receipt generation. A missing required input file fails the explicit full regeneration but does not break normal application build or runtime lookup.
- No generated DB or JSON is hand-edited.

## Test design

- Python unit fixtures prove raw field retention, hashes, atomic behavior, and GTIN validation.
- Node unit fixtures prove exact precedence, sentinel handling, safe text normalization, status classification, and hard-vs-contextual quarantine.
- Builder integration fixtures execute the real scripts on small files and inspect JSON/SQLite output, including zero-padding variant collisions and missing/LFS-pointer retail input.
- Existing retail lookup and decode corpus tests prove backward compatibility and that partial rows never become known hits.
- Full-source gates prove source/known/review/quarantine reconciliation, a known-count floor of 4,047,273 minus explicitly enumerated conflict/quarantine deltas, zero unexplained identity drift, zero serving variant-family ambiguity, and no review/quarantined barcode in serving artifacts.
- Final gates: focused generator/runtime/decode/store tests, `npm run test:ledger`, `npm run proof:local`, `npm run test:golden`, `npm run test:corpus-drift`, `npm run build`, and mock-only browser gates relevant to counting behavior.

## Out of scope

- Live or paid enrichment calls
- Turso/Firebase/production imports or schema promotion
- Deploy, push, or PR creation
- Inferring brand/category/name from neighboring products, images, prefixes, or language models
- Declaring source licensing cleared
- Creating or shipping a duplicate curation database before there is an approved consumer

## Rollback

The serving JSON, meta, knowledge DB, gzip, release manifest, and receipts are generated to versioned temporary paths. Before a full rebuild, the existing local serving artifacts are copied to a timestamped `C:\tmp` backup. Rollback restores only those exact generated artifacts. Source code and raw exports are not destructively changed.

## Artifact and license policy

- Raw OFF export and enriched JSONL: local-only, ignored, never deployed by this task.
- Review/diff receipts: local audit evidence; they contain no image binary and are not published.
- Serving JSON: existing Git LFS-tracked artifact; availability is verified with `git lfs ls-files` and pointer-content tests, but this task does not push it.
- Serving meta: tracked ordinary JSON.
- Slim DB and gzip: local ignored build artifacts; this task does not claim CI or Vercel receives them.
- Source URLs and image URLs are evidence references only. Image content is not downloaded or redistributed.
- All outputs remain local research artifacts until the exact OFF license/version, attribution requirement, and redistribution policy are captured and owner-reviewed. "Green" here means local quality and reproducibility, not deployment clearance.
