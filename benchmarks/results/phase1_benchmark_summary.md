# Phase 1 benchmark summary

- Source file: `benchmarks/phase1_100_codes.csv`  |  codes tested: **4**  |  generated against http://localhost:3000

## Lookup path breakdown
| path | count |
|------|------:|
| fast_page_fetch | 2 |
| firecrawl_fallback | 1 |
| needs_review | 1 |

Resolved: **3** / 4  |  Needs Review: **1**  |  Failed: **0**

## Accuracy (honest - only graded when ground truth was provided)
| verdict | count |
|---------|------:|
| partial | 3 |
| needs_review | 1 |

## Latency (wall-clock per code, ms)
| metric | ms |
|--------|---:|
| average | 13,633 |
| median (p50) | 101 |
| p95 | 40,073 |
| min | 85 |
| max | 40,073 |

### Slowest 10
| # | code | path | ms |
|--:|------|------|---:|
| 1 | 710154236681 | needs_review | 40,073 |
| 2 | 810118139604 | firecrawl_fallback | 14,274 |
| 3 | 6977228152610 | fast_page_fetch | 101 |
| 4 | 070330645936 | fast_page_fetch | 85 |

## Cache proof
- resolved codes re-run: **3**
- confirmed cached on 2nd call (zero spend): **3**

## Provider usage
- Firecrawl credits (this run): **14**
- Gemini calls: **3**  |  OpenAI calls: **3**
