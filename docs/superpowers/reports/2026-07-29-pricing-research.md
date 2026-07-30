# Pricing Research: Is $150/mo Defensible for Scanbin (Tire Shop Beachhead)

Date: 2026-07-29
Method: web research only (WebSearch), no outreach, no accounts, no paid calls.
Scope: master plan section 3b-B price sanity check.

## 1. Sources Table

| Source | What it covers |
|---|---|
| itqlick.com/sortly-pro/pricing, help.sortly.com | Sortly pricing tiers |
| trustradius.com/products/inflow-inventory/pricing, inflowinventory.com/software-pricing-inflow | inFlow pricing tiers |
| zoho.com/us/inventory/pricing, costbench.com/software/inventory-management/zoho-inventory | Zoho Inventory pricing tiers |
| tekmetric.com/pricing, capterra.com/p/190952/Tekmetric/pricing | Tekmetric (auto/tire shop management) pricing |
| wifitalents.com/best/tire-shop-management-software, gitnux.org/best/tire-shop-management-software | Shop-Ware and general tire-shop software pricing |
| tireguru.net/pricing | Tire Guru (pricing not published on page, quote-only) |
| statista.com/statistics/1456467, businesswire.com (NRF 2023 survey), spot.ai/blog/shrinkage-in-retail | Retail shrinkage benchmarks |
| shopify.com/blog/physical-inventory, joinhomebase.com/blog/how-to-take-a-physical-inventory-count | Physical inventory count labor patterns |
| kladana.com/blog/inventory-management/barcode-inventory-software | General barcode-scanning SaaS pricing range |

Bay-masteR: no pricing found in this pass (unpublished / not indexed); would need a direct site visit or quote request to confirm, which is out of scope for this research-only pass.

## 2. Competitor Table

| Product | Audience | Price | Source |
|---|---|---|---|
| Sortly | General small-biz inventory/asset tracking | Free tier; Advanced $49/mo; Ultra $149/mo; Premium $299/mo; Enterprise custom | help.sortly.com, itqlick.com |
| inFlow Inventory | Small-to-mid inventory + order mgmt | Entrepreneur $186/mo (2 users); Small Business $436/mo; Mid-Size $999/mo | inflowinventory.com |
| Zoho Inventory | General retail/ecommerce inventory | Free tier; Standard $29/mo; Professional $79/mo; Premium $129/mo; Enterprise $249/mo (annual pricing; month-to-month higher) | zoho.com/us/inventory/pricing |
| Tekmetric | Auto repair shop management (incl. tire) | Start $199/mo; Grow $349/mo; Scale $439/mo; Enterprise custom. Add-on Tire Suite $39/mo/shop | tekmetric.com/pricing |
| Shop-Ware | Auto repair/tire shop management | ~$199-265/mo base (varies by source/billing), +$99/mo per additional technician | wifitalents.com, gitnux.org (secondary aggregator sources, not the vendor site directly - lower confidence) |
| Tire Guru | Tire/auto dealer shop management | Not published; quote-only | tireguru.net/pricing |
| Bay-masteR | Tire/auto shop management | Not found in this pass | n/a |
| General barcode-scanning SaaS | Small-biz inventory scanning | Roughly $10-100/mo typical band, up to ~$349/mo for feature-heavy tiers | kladana.com aggregator summary |

Takeaway: generic inventory tools cluster $29-150/mo for small-business tiers. Tire/auto-specific shop management software (which bundles far more than inventory - scheduling, invoicing, digital inspections) runs $199-440+/mo. Scanbin's $150/mo sits above generic inventory tools but meaningfully below tire-specific shop management suites, positioned as a focused add-on rather than a full shop-management replacement.

## 3. Value Math (tire shop)

All figures below are estimates assembled from general retail benchmarks, not tire-industry-specific studies; label accordingly.

- Physical count labor: a small retailer count is commonly described as ~6 staff x ~8 hours (estimate, Shopify/Homebase pattern description, not a wage-costed study). At a conservative $20/hr blended wage, that is a rough $960 in labor per full count. Many shops do this only 1-2x/year, so this is an infrequent but real cost; cycle counting in between is where a scanner tool's daily value would need to be argued from time saved per session, not from the annual full-count number alone.
- Shrinkage: NRF/Statista puts average retail shrink at roughly 1.4-1.6% of sales; a 2023 industry survey found 68% of small/mid retailers exceeding that. These are general-retail, not tire-specific, so applying them to a tire shop's stock value is an extrapolation, not a verified benchmark.
- "One miscounted stocking decision": no credible tire-specific dollar figure was found in this pass. A directional way to frame it in the pitch (label as illustrative, not sourced): a single miscounted SKU that triggers an unnecessary reorder or a stockout of one tire model line (rough range one to several hundred dollars depending on the SKU and lost sale) is the kind of single-event cost the corpus-matching accuracy is meant to prevent - this needs a real customer conversation to firm up, not a generic retail citation.

## 4. Verdict and Tier Draft

Verdict: $150/mo as a single flat price is defensible as an anchor point (it sits comfortably inside the range where inFlow/Sortly upper tiers and Zoho's higher tiers already live), but it is risky as the ONLY price - it is too expensive next to $29-79 generic tools for a shop that just wants basic counting, and it looks cheap/underpriced next to $199-440 tire-specific shop-management suites for a shop that would compare Scanbin to Tekmetric/Shop-Ware. A tiered structure captures both ends better than one flat number.

Draft 3-tier menu (candidate price points, not final):

- Starter, ~$49-79/mo: solo/small shop, capped scans/month (e.g. 1,000-2,000), 1 user, corpus lookup + manual review only (no AI decode ladder spend).
- Standard, ~$149-179/mo: this is the natural home for the current $150 anchor. Higher/uncapped scans, multi-user (2-4), reconciliation/export, moderate AI decode ladder allowance (cost-capped).
- Pro/Multi-location, ~$299-399/mo: multiple locations or higher user count, priority AI decode allowance, variance/"we found you $X" reporting as a named feature, closer to where Tekmetric/Shop-Ware customers already budget.

Gates to use across tiers: scans/month cap, number of users, number of locations, AI decode ladder volume/cost cap, and whether reconciliation/variance reporting is included (this last one is the natural upsell hook tied to the "we found you $X" pitch).

## 5. Confidence Level and Open Questions

Confidence: medium. Competitor price points are well-sourced from vendor/aggregator pages (a few aggregator-only figures for Shop-Ware are flagged lower-confidence above). The value-math numbers are general-retail estimates, not tire-industry-specific studies, and are labeled as such throughout.

What only a real customer conversation can answer:
- What a tire shop actually believes one miscounted SKU or one bad reorder costs them, in their own words.
- Willingness to pay $150/mo as a bolt-on next to whatever shop management software (if any) they already pay for.
- Whether "scans/month" or "AI decode volume" is a gate customers understand, versus a flat unlimited price they will find easier to say yes to.
