# Real-limited benchmark (4 real codes) — LIVE providers

> **Real 100-code benchmark blocked because no 100-code owner file was provided.**
> This run uses the only real codes available (`benchmarks/phase1_100_codes.csv`, 4 codes) against
> live Gemini/OpenAI/Firecrawl. Firecrawl is prepaid (tracked in firecrawl-ledger.json); metered
> Gemini/OpenAI cost is tracked in spend-ledger.json.

- Codes: **4**  |  resolved: **3**  |  needs_review: **1**  |  failed: **0**
- **false_known: 0** (no wrong-product Known result; misses honestly route to needs_review)
- Cache proof: **3/3** resolved codes confirmed cached on 2nd call (zero new spend)
- Firecrawl credits (this run): **14**  |  Gemini calls: **3**  |  OpenAI calls: **3**

## Lookup path
| path | count |
|------|------:|
| fast_page_fetch | 2 |
| firecrawl_fallback | 1 |
| needs_review | 1 |

## Accuracy (graded only where ground truth provided)
| verdict | count |
|---------|------:|
| partial | 3 |
| needs_review | 1 |

## Latency (wall-clock per code, ms)
| metric | ms |
|--------|---:|
| avg | 15775 |
| median (p50) | 136 |
| p95 | 40027 |
| min | 51 |
| max | 40027 |

### Per-code
| code | path | verdict | latency ms | fc credits | product (truncated) |
|------|------|---------|-----------:|-----------:|---------------------|
| 810118139604 | firecrawl_fallback | partial | 22884 | 7 | Wholesale Acrylic Paint Markers Set – 24 |
| 070330645936 | fast_page_fetch | partial | 136 | 0 | Exclusive Smokes Bic Lighter Texas |
| 6977228152610 | fast_page_fetch | partial | 51 | 0 | Phatoil Lavender Essential Oil Premium G |
| 710154236681 | needs_review | needs_review | 40027 | 7 |  |

> Note: "partial" verdict = the live decode found the right item but the name token-overlap vs the
> ground-truth label was < 60% (marketplace listings phrase names differently). These are SUGGESTIONS
> for Needs Review, never auto-counted. The one needs_review was an honest provider timeout / no match.
