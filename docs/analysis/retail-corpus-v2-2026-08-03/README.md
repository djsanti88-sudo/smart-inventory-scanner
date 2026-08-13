# Retail corpus v2 rebuild — 2026-08-03

This is the local, offline rebuild record for the Open Food Facts retail source. No paid provider,
production database, Firebase project, Turso database, deployment, or customer data was touched.

## Result

- Raw rows scanned: **4,532,767**
- Malformed rows: **2**
- Invalid-GTIN rows rejected: **159,638**
- Checksum-valid observations: **4,373,127**
- Unique GTINs retained with immutable source evidence: **4,373,077**
- Conflicting duplicate GTINs routed to review: **45**
- Serving-safe known products: **4,046,693**
- Review rows: **325,846**
- Quarantined rows: **538**
- Invalid JSON rows: **0**
- Serving drift from the frozen baseline: **42 removals**, with zero additions, renames,
  brand changes, category changes, newly quarantined rows, or dequarantines.

The 42 removed rows failed the stricter evidence contract. They were not silently relabeled or
invented. Rows lacking enough exact source evidence remain in the review ledger instead of being
promoted to known products.

## Artifacts and receipts

- `off-process.receipt.json`: raw-source and enriched-evidence counts plus SHA-256 hashes.
- `review.jsonl.gz`: complete non-serving review/quarantine ledger.
- `projection-diff.json`: exact serving drift against the frozen baseline.
- `knowledge-db.receipt.json`: SQLite row counts, integrity checks, and DB/gzip hash parity.
- `src/server/retail-knowledge/retailKnowledge.generated.meta.json`: classification and
  normalization totals.

The final SQLite database contains **4,046,693 retail rows** and **78,838 tire rows**. Its SHA-256 is
`e0b950a0e54d2465e996d159d660a045182af001a6d8ca5460793a406e1844ff`; the compressed artifact
reproduces those exact database bytes and both copies pass `PRAGMA integrity_check`.

## Safety contract

- Source evidence is preserved in the enriched JSONL rather than overwritten during cleanup.
- Primary product names are never filled from alternate/generic names.
- Brand and English category use documented source-field precedence only.
- Exact poison canaries and zero-padding-equivalent conflicts fail closed.
- Duplicate conflicts, partial evidence, and unidentified rows go to review.
- Generated outputs are staged, validated, and atomically promoted with rollback tests.
- The runtime serving tuple is unchanged; catalog hits remain suggestions, not verified identity.

The upstream data-license/provenance decision remains an owner/legal gate. These artifacts are local
and must not be published or imported into a live system solely on the strength of this rebuild.
