# Open Food Facts (ODbL) Attribution Note (Draft)

> DRAFT - AI-generated from standard templates 2026-07-29. NOT legal advice. Professional legal review REQUIRED before charging real customers or publishing.

## 1. Background

Scanbin's retail product catalog includes data derived from Open Food Facts, a collaborative, openly licensed product database. Open Food Facts data is made available under the **Open Database License (ODbL) v1.0**, and individual database contents may also carry the **Database Contents License (DbCL)** for the data itself. Using this data carries attribution obligations that must be met wherever the derived data (or a product built from it) is made available to users.

## 2. Required Attribution Text

The following attribution notice must be displayed, at minimum, in an about/credits surface reachable from the product:

> "Contains information from Open Food Facts, made available under the Open Database License (ODbL)."

[PLACEHOLDER: Confirm the exact required phrasing and any required hyperlink target (e.g., linking to https://opendatacommons.org/licenses/odbl/1-0/ and https://world.openfoodfacts.org/) with counsel, since ODbL attribution requirements can be interpreted to require a link to the license text and to the data source.]

## 3. Where Attribution Must Be Shown

- An **About** or **Credits** page/section within the app, accessible from account or settings navigation, listing all third-party data sources used, including Open Food Facts under the ODbL.
- Optionally (recommended, not yet confirmed as required), a shorter reference near any UI surface that visibly displays retail product data sourced from Open Food Facts (for example, a small "data sources" link near product detail views).
- [PLACEHOLDER: Confirm with counsel whether attribution must also appear in exported data (CSV exports, reports) that include Open Food Facts-derived fields.]

## 4. Open Share-Alike Question (Flagged for Professional Review)

The ODbL includes a **share-alike** provision that can require that any "derivative database" built using ODbL-licensed data also be distributed under compatible license terms if that derivative database is itself shared or made available to others (as distinct from simply using the data to power an application's features).

This raises an open, unresolved question that requires professional legal review before commercial launch:

- **Does Scanbin's combined retail catalog (which merges Open Food Facts data with other proprietary and licensed sources) constitute a "derivative database" that must itself be shared under ODbL/DbCL-compatible terms, or does serving the data only through the application's UI/API (rather than redistributing the underlying database) fall outside the share-alike trigger?**
- This determination affects whether the combined catalog (including any proprietary tire/retail data merged with Open Food Facts data) can remain fully closed/proprietary, or whether some obligation to offer the derived dataset (or the Open Food Facts-derived portion of it) under compatible terms may apply.
- Related sub-questions for counsel: whether Scanbin's "Produce" and "Adapt" activities under the ODbL definitions apply to how the catalog is built and merged; whether offering data through an API/app UI counts as "distributing" or "making available" the database under the ODbL; and whether the DbCL implications for the underlying facts/individual data records differ from the ODbL implications for the database structure as a whole.

**Recommendation:** Do not represent the combined retail catalog as fully proprietary/closed in any customer-facing or investor-facing material until this question is resolved by IP/open-data-licensing counsel.

## 5. Action Items

- [ ] Add an About/Credits page in-app with the attribution text from Section 2.
- [ ] Confirm final attribution wording and link targets with counsel.
- [ ] Resolve the share-alike/derivative-database question in Section 4 with counsel before broad commercial launch.
- [ ] Document the resolution and any resulting licensing decision in this file once finalized.

---

*This document is a draft template. It has not been reviewed by a licensed attorney with open-data licensing expertise and must not be relied on as a compliance determination until professional review is complete.*
