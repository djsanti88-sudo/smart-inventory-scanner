# Seed benchmark (deterministic, $0 spend)

Deterministic seed benchmark (no network, no paid calls). Proves resolver/idempotency/CSV correctness with $0 spend.

- Scans: **14**  |  Known: **13**  |  Needs review: **1**  |  Conflict: **0**
- **false_known: 0** (gate: 0)
- Name accuracy (known): **100%**
- Alias resolution: **6/6**
- Needs-review rate: **7.1%**
- **Duplicate prevention: 100%** (13/13 retries were no-ops; gate: 100%)
- Paid calls: **0**  |  Firecrawl credits: **0**  |  Repeat paid avoided: **100%**
- CSV round-trip: **PASS** (export->parse total qty 13 == 13)

## Lookup path distribution
| path | count |
|------|------:|
| deterministic_known | 13 |
| needs_review | 1 |

## Latency (per resolve, ms)
| metric | ms |
|--------|---:|
| avg | 0.038 |
| median | 0.015 |
| p95 | 0.228 |
| min | 0.004 |
| max | 0.228 |
| slowest | nokian-barcode (0.228 ms) |

> Note: this is the DETERMINISTIC path (resolver + inventory + CSV). It deliberately spends $0 and
> exercises no AI/Firecrawl. The live paid lookup paths are measured separately in
> `real_limited_4_code_results.*` (4 real codes; the real 100-code benchmark is blocked — no owner file).
