# Strategy Bots (Track 2)

Business-intelligence "bots" = analysis routines whose output is the reports in
`reports/strategy-bots/latest/`. They help decide what to build, charge, show, and hide. They do NOT
change app code, scanner/resolver logic, Firebase rules, auth, or security.

## Reports
| bot | report(s) | command |
|-----|-----------|---------|
| MarketingAdvisorBot | marketing_advice.md | `npm run strategy:marketing` |
| FeatureROIBot | feature_roi_matrix.md / .csv | `npm run strategy:roi` |
| PricingAdvisorBot | pricing_recommendations.md | `npm run strategy:pricing` |
| CompetitionBot | competition_report.md / competitor_matrix.csv | `npm run strategy:competition` |
| WebsiteBuyerBot | website_buyer_review.md | `npm run strategy:buyer` |
| MonetizationBot | monetization_recommendations.md | (in `strategy:bots`) |
| (master) | TRACK2_STRATEGY_MASTER_REPORT.md | `npm run strategy:bots` |

`npm run strategy:bots` validates all reports exist and prints a sources/setup note.

## Research rules (followed)
Public web/search only — no logins, paywalls, robots/ToS/CAPTCHA bypass, no private scraping, no wholesale
copying. Competitor pricing is public list pricing with cited URLs; non-public pricing is marked "not
public" (e.g., tire databases). Competitor data changes — verify before quoting a customer.

## Headline (see TRACK2_STRATEGY_MASTER_REPORT.md)
Wedge: accurate, fast counting for tire/auto/parts. Direct rival: Sortly. Price $99/$199 + $199 setup.
#1 pre-sale blocker is the customer-safe foundation (hide internals + enforce roles + stop code-DB
extraction) — also the Track 1 P0 security item. Build that next; don't chase ERP/order features.
