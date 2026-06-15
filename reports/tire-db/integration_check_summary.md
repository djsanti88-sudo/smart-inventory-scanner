# Tire Catalog Integration Check (Stage 7)

Isolated namespace: `biz-tire-itest` (no production Firebase). Emulator persistence for tire data is proven
end-to-end in the Stage 2 controlled pilot; this check proves the GENERATED 100-stage catalog flows
through the app's real CSV import + deterministic resolver.

- Catalog records: **20**
- Importable (has a scannable code, non-conflicted): **2**
- Products created on import: **2**
- Approved aliases created: **2**
- Sample imported code that resolves **Known**: `000067` -> product `prod-import-s-1`
- Re-import is idempotent (already-mapped codes -> conflicts, **0** new products).
- Spec-only records (no code) are correctly EXCLUDED from the import-ready CSV.

> Honest note: the importable codes here are retailer **product/tire codes** (candidate, not verified
> UPC/GTIN barcodes), because no free source published scannable tire barcodes (see source_inventory.md).
> The mechanism is proven: any record carrying a code imports and resolves on scan. The moment a real
> shop/vendor CSV (with true barcodes) is supplied, the same path yields verified-scannable records.

Proof type: automated unit/integration (pure, deterministic). $0 spend.
