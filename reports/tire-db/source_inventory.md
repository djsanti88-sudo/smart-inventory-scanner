# Tire Source Inventory — Discovery Gate (BLOCKING)

Generated 2026-06-15. **No tire record generation may begin until this file and `source_inventory.json`
exist.** This ranks every candidate source by safety, legality, bulk feasibility, barcode coverage,
and cost against the **$30 cash cap** (Firecrawl is prepaid, tracked separately, capped at 500 credits /
50 pages per domain).

## Source table
| source | type | access | bulk | est. records | barcode coverage | cost | terms/robots risk | recommended_use |
|--------|------|--------|------|--------------|------------------|------|-------------------|-----------------|
| Owner shop export | shop_export | owner export needed | yes | owner's inventory | UPC/GTIN/SKU | $0 | none | **owner_file_needed** |
| Vendor/distributor CSV | vendor_csv | owner export needed | yes | 100s–1000s | UPC/GTIN/SKU | $0 | low | **owner_file_needed** |
| Tireweb Library | distributor_catalog | API | yes | ~240,000 | UPC/EAN/GTIN | paid license (likely >$30) | license/redistribution | **owner_review_needed** |
| TiresAddict CSV | distributor_catalog | public_csv | yes | large | UPC/GTIN | paid (~near/over $30) | license | use_only_if_budget_allows |
| EANdata | barcode_api | API | partial | broad (not tire-curated) | UPC/GTIN | paid | license | use_only_if_budget_allows |
| UPCitemdb (free) | barcode_api | API (key) | no | broad; 100/day, 40 search/day | UPC/GTIN | $0 (needs key signup) | rate-limited; own-ops license | **use_for_verification_only** |
| Go-UPC | barcode_api | API | no | broad | UPC/GTIN | **$74.95/mo min (over cap)** | subscription | **avoid** |
| Barcode Lookup API | barcode_api | API | no | broad | UPC/GTIN | paid | anti-bot (403); ToS | **avoid** |
| GS1 / Verified by GS1 / GEPIR | gs1_lookup | login | no | GTIN verification | UPC/GTIN (verify only) | $0 single | bulk restricted | use_for_verification_only |
| Manufacturer spec pages | manufacturer_catalog | public web | partial | 1000s specs | **barcodes rarely published** | Firecrawl (prepaid) | med-high; verify robots/ToS | use_for_verification_only |
| Retailer pages (TireRack/Amazon/etc.) | retailer_page | not allowed | no | large | sometimes UPC | n/a | **HIGH (ToS/anti-bot 403)** | **avoid** |
| Scan-confirmed field data | field_scan | app | partial | **0 today** | UPC/GTIN/SKU | $0 | none | use (primary long-term) |

## The binding finding
**There is no safe, free, bulk source of scannable tire barcodes (UPC/GTIN).** The sources that *do*
carry tire barcodes in bulk (Tireweb Library, TiresAddict, EANdata, Go-UPC, Barcode Lookup, UPCitemdb
paid) are **paid/licensed, one-by-one, or require an owner-provided key/file** — and the cheapest
per-code option (Go-UPC) already exceeds the $30 cap. Manufacturer/retailer pages either don't publish
barcodes or forbid automated extraction (confirmed 403/anti-bot this run). Tire *specs* (size, load
index, speed rating) are public non-copyrightable facts and can be gathered via Firecrawl, but that
yields **spec-only candidates, not scannable records**.

## Automatic go / no-go
- **100-stage → CONDITIONAL GO (candidate-grade):** build the tire pipeline + a small, legal candidate
  sample of factual specs (Firecrawl, robots-permitted, facts-only, capped). Verified-scannable barcode
  coverage will be **low** by the finding above.
- **500-stage → NO-GO:** no safe free/bulk scannable source; one-by-one paid APIs exceed $30 and are
  forbidden for bulk by the owner's `bulk_source_rule`. **Stop before spending.**
- **5000-stage → NO-GO:** same blocker; reaching 5000 scannable records needs a paid/licensed bulk tire
  DB (Tireweb/TiresAddict) or an owner/vendor CSV — an owner purchasing/file decision.

**Decision:** complete discovery → build + test the pipeline → run a bounded, honest 100-stage candidate
sample → **STOP before 500/5000** with this cost/source blocker. No padding, no ToS/robots bypass, ≤$30.

## What unblocks the bulk stages (for the owner)
1. Drop a shop/vendor tire CSV into `data/tire-catalog/` (best — free, has scannable codes), **or**
2. License a bulk tire DB (Tireweb Library ~240k tires, or TiresAddict) — a purchasing decision, **or**
3. Provide a UPCitemdb (or similar) API key + raise the budget for per-code verification at scale, **or**
4. Let the shop scan live — `field_scan` becomes the strongest source over time.
