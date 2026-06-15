# FeatureROIBot — feature ROI matrix

Scores 1–5. Full data in `feature_roi_matrix.csv`. ROI lens = customer value × willingness-to-pay ×
retention × demo/moat value, discounted by difficulty + risk.

## Highest ROI (build/keep first)
1. **Multi-code alias learning (separator-insensitive)** — the differentiator + moat (5/5/5). Already built.
2. **Wrong-category mismatch guard** — best demo moment + trust; cheap. Already built.
3. **Scan + live count + duplicate prevention + CSV export** — table stakes; must be flawless.
4. **PlatformOwner-protected code DB** — the moat. Currently a P0 hole (customers can extract it). Highest
   strategic ROI to FIX, even though customers won't "pay" for it directly.
5. **Role-based permissions (enforced in UI/exports)** — unlocks selling to multi-person shops safely.

## Strong add-on / premium ROI
- Tire catalog import/enrichment (premium; high moat) · part-number-only enrichment (add-on) · low-stock /
  stock-target (Shop+ / add-on; high retention) · vendor templates · employee accountability · multi-location
  (enterprise) · API integrations (Shop-Ware/QuickBooks; enterprise, high willingness-to-pay, high effort).

## Delay / do-not-build-yet
- Product image lookup (low value, medium effort) · overstock alerts (low) · advanced/scheduled exports
  (until a customer asks) · deep ERP/order/PO features (that's inFlow/Zoho's game — don't chase it).

## Classification summary
- **must-have core (all paid):** scan, live count, dedupe, Needs Review, CSV export, protected code DB.
- **paid core:** multi-code learning, mismatch guard, CSV import, scan logs, bad-link repair, role
  permissions, offline queue, product search.
- **add-on:** enrichment, part-number-only import, vendor templates, stock targets, low-stock, employee
  accountability, advanced exports.
- **premium:** tire catalog enrichment. **enterprise:** multi-location, API integrations.
- **wait:** image lookup, overstock alerts.
