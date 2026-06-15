# MonetizationBot — revenue levers

How each opportunity should be packaged (tier vs add-on vs one-time vs usage), who pays, and priority.
Priorities use the Track 2 P-scale (P1 before pilot … P4 future).

| opportunity | package | who pays / why | suggested price | billing | effort | risk | priority |
|-------------|---------|----------------|-----------------|---------|--------|------|----------|
| Core scan/count/dedupe/CSV | all paid plans | every shop; the base value | in $99 Basic | monthly | done | low | P1 |
| Multi-code accuracy + mismatch guard | all paid plans (differentiator) | shops that got burned by wrong parts | in $99 | monthly | done | low | P1 |
| Enforced roles + employee accountability | Shop Pro | owners who don't want staff seeing/exporting everything | in $199 | monthly | med-high | med | **P1 (also security)** |
| Manager reports / audit-history UI | Shop Pro | managers needing oversight | in $199 | monthly | med | low | P2 |
| Low-stock / stock-target memory | Shop Pro or add-on | shops avoiding stockouts (high retention) | in $199 or +$29/mo | monthly | med | low | P2 |
| Vendor import templates | add-on | shops with messy vendor CSVs | +$19–$39/mo | monthly | low-med | low | P2 |
| Bulk CSV cleanup / DB cleanup service | one-time service | onboarding shops with bad data | $199–$499 | one-time | med | low | P2 |
| Product / part-number enrichment (auto-identify) | add-on | shops with many unknown codes | +$29–$49/mo or usage | monthly or usage | med-high | med (AI cost) | P3 |
| Tire catalog enrichment ("tire library") | premium add-on | tire shops wanting turnkey catalog | +$49–$99/mo | monthly | high (license) | med | P3 |
| Multi-location rollups | Multi-site tier | 2–5 location operators | $399/mo | monthly | high | med | P3 |
| API / Shop-Ware / QuickBooks integrations | Enterprise | chains/integrators (high WTP) | $499+ custom | monthly | high | med-high | P4 |
| Custom onboarding / setup | one-time fee | every new shop | $199+ | one-time | low | low | **P1** |
| Security/audit/SSO package | Enterprise | larger orgs | bundled $499+ | monthly | high | med | P4 |

## Do NOT monetize yet
- Product image lookup, overstock alerts, advanced/scheduled exports — low willingness-to-pay until asked.
- **Never sell or expose the global code knowledge base** — it's the moat; its value is *retention +
  defensibility*, realized by keeping customers in, not by selling the data.

## The two near-term money moves
1. **$199 setup fee + $99/mo Basic** for pilots — revenue from day one, funds onboarding.
2. **$199 Pro tier** (roles + manager/audit + low-stock) — the retention upsell once a shop is hooked on counting.
