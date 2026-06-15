# Tire DB — 5000-Stage: NO-GO (stopped before spending)

**Decision: NOT STARTED.** Same binding blocker as the 500-stage, at larger scale. Per the owner's
critical rule ("If 5,000 cannot be done safely within the remaining budget, stop before starting the paid
part and report the projection. Do not partially spend into failure."), we stopped before any spend.

## Projection / why it cannot be done within $30
- Scannable records require codes. Per-code paid APIs: Go-UPC $74.95/mo (5,000 lookups) — that single
  plan already exceeds the $30 cap, and tire UPC coverage is uneven. Reaching 5,000 *verified scannable*
  records this way is both over budget and forbidden (one-by-one) by the owner's `bulk_source_rule`.
- The clean way to 5,000 scannable records is a licensed bulk tire database (e.g. Tireweb Library, which
  holds ~240,000 tires indexed by UPC/EAN/GTIN) or an owner/vendor export — an owner purchasing/file
  decision, not achievable within $30 / no-files this run.
- Firecrawl could produce thousands of *spec-only* rows, but with no scannable barcode they are not a
  tire *barcode* database and counting them as 5,000 would be padding (forbidden).

## What was preserved
- 100-stage candidate outputs intact; pipeline ready for a real bulk source.

Spend on this stage: **$0 cash, 0 Firecrawl credits** (did not start).
