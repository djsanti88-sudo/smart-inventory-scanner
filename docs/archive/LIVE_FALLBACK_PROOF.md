# Live proof - deep parallel fallback decodes 810118139604 (2026-06-14)

Owner-authorized live re-test (1 paid decode + 1 free cached call). Dev server, real keys, `e2e:false`.
This is the exact barcode that started the saga - previously stuck in Needs Review.

## Call 1 - live decode (POST /api/ai-lookup, code 810118139604)

- **HTTP 200 in 16.0s** (was 66s before the deep+parallel tuning)
- **decision: `verified`**, `exactCodeEvidenceVerifiedByApp: true`, evidenceStrength `fetched_source`
- **product:** "Wholesale Acrylic Paint Markers Set - 24 Metallic Colors, 2mm Bullet Tip, Water-Based,
  Multi-Surface" (KINGART, SKU 409-24M, UPC 810118139604), source `https://www.faire.com/product/p_uxqrb39cyu`
- **reasonCode: `fallback_discovery_found_product`**
- Per-provider diagnostics (honest):
  - page-fetch: `no_match` (794ms) - only the Go-UPC "Product Not Found" page; correctly rejected
  - gemini: `timeout` (10s) / openai: `timeout` (10s) - grounded models still slow; did not block success
  - **firecrawl: `ok` (6.0s), 6 candidates opened in parallel, exact code found, identity found**

The Firecrawl finder won the race in ~6s, opening all 6 safe candidates in parallel and reading the
Faire listing (which ranks ~#4, below the barcode-DB noise that the old top-3 scrape never reached).

## Call 2 - same code again (proves the cache)

- **HTTP 200 in 0.007s** (7 milliseconds), `debug.cached: true`
- Same verified product, **zero AI/Firecrawl spend** - the decode cache served it.

## What this confirms

- Fast path untouched; the deep, parallel, capped fallback only runs on a hard-fail and actually finds
  real listings now.
- Honest diagnostics distinguish timeout vs no-match vs found.
- A decoded barcode never re-pays for AI/Firecrawl in the running server.
