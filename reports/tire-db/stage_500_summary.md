# Tire DB — 500-Stage: NO-GO (stopped before spending)

**Decision: NOT STARTED.** Per the owner's `bulk_source_rule` and the source-discovery go/no-go, the
500-stage is a NO-GO and we stopped **before** any spend.

## Exact blocker
There is **no safe, free, or bulk source of scannable tire barcodes (UPC/GTIN)**. To reach 500 *scannable*
records the only paths are:
- a per-code paid barcode API — Go-UPC is **$74.95/mo minimum (over the $30 cap)** and one-by-one;
  Barcode Lookup is paid + anti-bot. The owner's rule explicitly forbids one-by-one paid lookup to
  reach 500/5000.
- a paid/licensed bulk tire database (Tireweb ~240k, TiresAddict) — an owner purchasing decision,
  almost certainly over $30 and with redistribution terms.
- an owner shop/vendor CSV — **not provided** this run.

Firecrawl (prepaid, abundant) can gather more *spec-only* candidates, but those carry **no scannable
barcode**, so scaling to 500 spec-only rows would not produce a usable tire *barcode* database and would
risk padding — which the owner forbid.

## What was preserved
- 100-stage candidate outputs (`tire_catalog_100.*`) are intact.
- Pipeline (`src/services/tire/tireCatalog.ts`) is ready to ingest a real bulk source immediately.

## What unblocks this stage
Provide a shop/vendor tire CSV (free, has codes), license a bulk tire DB, or supply a barcode-API key +
raise the budget. See `reports/tire-db/source_inventory.md`.

Spend on this stage: **$0 cash, 0 Firecrawl credits** (did not start).
