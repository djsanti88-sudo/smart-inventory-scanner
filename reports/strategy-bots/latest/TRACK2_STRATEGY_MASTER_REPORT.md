# Track 2 — Strategy Master Report (Smart Inventory Scanner)

Business brain for SIS: what to charge, show, hide, build next, and where competitors win. Specific to
this app. Sources cited in `competition_report.md`. No app code changed in Track 2.

## 1. Executive summary
SIS's defensible wedge is **resolution accuracy for tire/auto/parts counting** — scan any code shape
(barcode or dashed/spaced/slashed part number) and get the right product, with a guard that blocks
wrong-category mislinks, building a private code library the shop can't extract. That's a real
differentiator vs Sortly/Zoho's generic matching. The #1 blocker to selling is NOT a feature — it's that
the app currently *looks and behaves like a dev tool* and *leaks the code DB to customers* (Track 1 P0).
Fix that (hide internals + enforce roles + stop shipping the DB to the browser) and SIS is sellable at
**$99/$199** with a setup fee.

## 2. Best business opportunity
Own "**accurate, fast inventory counting for tire & auto shops**" — a niche Sortly/Zoho don't target and
inFlow/Zoho over-serve at 2–10× the price. Land tire/auto shops via white-glove pilots; expand to parts rooms / small warehouses.

## 3. Top 5 highest-ROI features
1. Multi-code separator-insensitive resolution (built — keep flawless). 2. Wrong-category mismatch guard
(built). 3. Protected code DB + **enforced roles** (fix the P0 leak). 4. Manager layer (roles + audit/scan
logs + low-stock) = the $199 retention tier. 5. CSV in/out reliability (table stakes).

## 4. Top 5 features to delay
Product image lookup; overstock alerts; advanced/scheduled exports; deep ERP/orders/PO (don't chase
inFlow/Zoho); multi-location until 2–5-location demand is real.

## 5. Recommended first paid pilot offer
**$99/mo + $199 one-time white-glove setup** (you import their products + seed aliases + train staff).
Waive setup for the first 1–2 design partners in exchange for testimonials. (pricing_recommendations.md)

## 6. Recommended pricing tiers
Free trial → **Shop Basic $99** → **Shop Pro $199** → **Multi-site $399** → **Enterprise $499+**. Two
everyday tiers ($99/$199) keep it shop-owner-simple. Don't undercut Sortly's $49 — win on accuracy + niche.

## 7. Recommended add-ons
Tire catalog enrichment (premium +$49–$99/mo), part-number enrichment (+$29–$49/mo), vendor templates
(+$19–$39/mo), bulk CSV cleanup (one-time $199–$499), extra locations, API connectors. (monetization_recommendations.md)

## 8. Competitor comparison summary
Direct rival = **Sortly** ($49/$149/$299, strong mobile/brand). **inFlow** ($186–$999) and **Zoho** ($39–
$299) are heavier order/ERP systems. **Tireweb/TyresAddict** are tire *data* sources (pricing not public) —
treat as suppliers/add-on, not rivals.

## 9. What competitors do better
Native mobile apps + photos + QuickBooks (Sortly); full orders/POs/accounting/multichannel + integrations
(inFlow/Zoho); mature reporting, onboarding, brand, and a true free tier (all).

## 10. What we do better
Separator-insensitive multi-code identity; wrong-product guard; tire/auto niche fit; a compounding private
code knowledge base that customers can't export (after the P0 fix).

## 11. Website / demo recommendations
One-sentence promise + 20s multi-code scan loop above the fold; CTA "Book a 15-min setup call"; show the
guard + CSV export; tire/auto branding + a design-partner quote; remove raw-code/GTIN/"AI" surfaces from
anything a prospect sees. (website_buyer_review.md, marketing_advice.md)

## 12. Customer objections → answers
"We use a spreadsheet/Shop-Ware" → time a real count in the demo. "Too complex" → counter scans with zero
training. "Our weird vendor codes?" → the multi-code/separator demo. "Is my data safe?" → "your codes stay
yours, non-exportable" (after P0 fix). "Cheaper than Sortly?" → priced on accuracy + niche, not feature count.

## 13. Features that protect the moat
The private/global code knowledge base + alias learning + the resolver/normalizer + (after fix) server-side
customer resolution so the DB never reaches the browser.

## 14. Features/words that must NOT be exposed publicly
The global code library, alias internals, GTIN/UPC/EAN maps, resolver/normalizer mechanics, provider names,
and that AI is used. De-brand to "product lookup / smart matching / product library."

## 15. What to build next
**The platform/customer role + data-protection foundation** (P1/P0): enforce roles in UI + exports,
server-side customer resolution, customer code-hiding, "AI" de-branding. It fixes the moat leak AND makes
the app demo like a shop tool. Then the **$199 manager tier** (roles + audit/scan-logs + low-stock).

## 16. What NOT to build yet
ERP/orders/PO; image lookup; overstock alerts; scheduled exports; multi-location/API until demand + paying interest.

## 17. Suggested next milestone
Ship the **customer-safe foundation** (de-brand + role enforcement + stop DB extraction) → then run a
**3-shop white-glove paid pilot at $99/mo + $199 setup** with the QA bots (incl. `qa:bots:live`) gating each change.

## 18. Source links
Sortly: capterra.com/p/169199 · sortly.com/blog. inFlow: softwareadvice.com/scm/inflow-inventory-profile ·
getapp.com/.../inflow-inventory. Zoho: capterra.com/p/146241/Zoho-Inventory/pricing. Tireweb:
tireweb.com/product/tireweb-library. TyresAddict: tyresaddict.com/help/databases.

## 19. Unverified assumptions
Competitor list prices change (verify before quoting); tire-DB licensing pricing is not public; SIS pricing
($99/$199) is a recommendation to validate with the first pilots; willingness-to-pay is estimated, not measured.

## 20. Open questions for Santiago
(a) Is the first wedge tire shops specifically, or auto/parts broadly? (b) Self-serve later, or stay
white-glove? (c) Budget/appetite to license a tire catalog (Tireweb) as a premium add-on? (d) Build the
customer-safe foundation before any outside pilot — agreed? (recommended: yes, P0.)

## Priority key
P0 = security/data exposure blocking sale (the code-DB leak). P1 = needed before pilot (role enforcement,
de-brand, setup/pilot offer). P2 = conversion/retention (manager tier, low-stock, vendor templates).
P3 = add-on/premium (enrichment, tire catalog, multi-site). P4 = future enterprise (API/SSO).
