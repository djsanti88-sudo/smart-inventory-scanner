# Tire Barcode Harvester — Run Log

## Run: run_20260622_001
**Date:** 2026-06-22
**Status:** IN PROGRESS
**Schema:** v3 (20-column tire_corpus_flat.csv)

---

## GATE 0: seed_from_example.py (Milestone 1 Complete)
**Date:** 2026-06-22
**Task:** Task 6 — seed from example fixture (zero credits)
**Status:** COMPLETE

### Results
- **Run 1 (Initial seed):** SEED COUNTS {'trusted': 100, 'backlog': 0, 'rejected': 0, 'dup_skipped': 0}, AUDIT PASS
- **Run 2 (Idempotency):** SEED COUNTS {'trusted': 0, 'backlog': 0, 'rejected': 0, 'dup_skipped': 100}, AUDIT PASS
- **Run 3 (Idempotency confirm):** SEED COUNTS {'trusted': 0, 'backlog': 0, 'rejected': 0, 'dup_skipped': 100}, AUDIT PASS
- **Final row count:** 100 (stable, no duplication)
- **Audit result:** PASS (schema, GTINs, sizes, ledger counts all valid)
- **Credits spent:** 0 (URL parsing only, no Firecrawl)

### Proof
✅ Pipeline proven: seed CSV → parse URLs → validate → route → write → ledger → audit
✅ Idempotency: runs 2 & 3 correctly skip duplicates
✅ No silent failures: trusted/rejected/backlog counts exact
✅ Data integrity: row count stable after all three runs (100, not 300)

---

## GATE 1: Robots/ToS Check — Task 8
**Date:** 2026-06-22
**Task:** Task 8 — Source collection via Firecrawl map
**Status:** ALLOWED — proceed to map call

### Robots.txt Result
- **URL fetched:** https://www.tiresandwheels.com/robots.txt
- **Method:** Python stdlib urllib (free, zero Firecrawl credits)
- **Content:**
  ```
  Sitemap: https://www.tiresandwheels.com/sitemap_index.xml
  User-agent: *
  Allow: /
  Disallow: /cart.php
  Disallow: /my-account
  ```
- **Analysis:** `User-agent: *` has `Allow: /` — all paths permitted unless explicitly Disallowed.
  `/product/tire/` is NOT in the Disallow list. Scraping product tire pages is ALLOWED.
- **Decision:** PROCEED with map call.

## GATE 2: Map Call Execution — Task 8
**Date:** 2026-06-22
**Status:** DONE_WITH_CONCERNS

### Map Call Stats
- **Command:** `firecrawl map https://www.tiresandwheels.com`
- **Credits spent:** 1
- **Remaining credits after run:** 159
- **mapped_total:** 101 URLs
- **product_urls** (containing `/product/tire/`): 3
- **new_queued:** 3

### Raw Output Sample (first 5 product-path URLs seen)
Only 3 product/tire/ URLs were in the 101 mapped:
1. `https://www.tiresandwheels.com/product/tire/EC583169/Otani/S142J/SA2100_35x12.50R20?srsltid=...`
2. `https://www.tiresandwheels.com/product/tire/EC369446/Nexen/18170NXK_N5000+Platinum_191563009552_265+65R17?srsltid=...`
3. `https://www.tiresandwheels.com/product/tire/EC9094/Nitto/180360/NT555R_205+55R14?srsltid=...`

### Parse Success Rate
- **Tested:** 3 queued URLs against `parse_url()`
- **Passed:** 1/3 = 33.3%
- **Failed:** 2 URLs (Otani SA2100, Nitto NT555R) — both lack the required `_BARCODE_SIZE` tail
  (no 8-14 digit barcode in URL slug)

### Analysis / Root Cause
1. `firecrawl map` returns a representative sample (~101 URLs), not the full product catalog.
   The site has thousands of tire products; the map endpoint is not the right tool to enumerate them.
2. 2 of 3 product URLs lack the barcode digit in their slug — these are edge-case listings
   (sizes like 35x12.50R20 are atypical) or Nitto NT555R (no barcode in slug).
3. The sitemap at `https://www.tiresandwheels.com/sitemap_index.xml` (referenced in robots.txt)
   would yield the full product catalog — use sitemap fetch as the correct next strategy.
4. The queue file (`tire_sources.csv`) appended correctly to the existing file;
   old header (`canonical_product_uid,...`) remains but new rows are correctly formatted.

### Concerns
- Parse success rate 33.3% is far below the 95% target.
- Only 3 product URLs from the map — too few to be useful for harvesting.
- Recommendation: Task 9 should use `--sitemap only` or direct sitemap XML fetch
  instead of (or in addition to) plain `firecrawl map`.


## Run: run_20260623_012323
- models_scraped: 1
- trusted_added: 4
- dup_skipped: 0
- credits_spent: 1
- rows_per_credit: 4.0
- remaining_credits: 152
- audit: AUDIT PASS
- timestamp: 2026-06-23T01:23:28Z

## Run: run_20260623_015030
- models_scraped: 14
- trusted_added: 330
- dup_skipped: 2
- credits_spent: 14
- rows_per_credit: 23.6
- remaining_credits: 138
- audit: AUDIT PASS
- timestamp: 2026-06-23T01:51:40Z

## Run: run_20260623_015150
- models_scraped: 14
- trusted_added: 208
- dup_skipped: 0
- credits_spent: 14
- rows_per_credit: 14.9
- remaining_credits: 124
- audit: AUDIT PASS
- timestamp: 2026-06-23T01:53:32Z

## Run: run_20260623_015341
- models_scraped: 12
- trusted_added: 261
- dup_skipped: 2
- credits_spent: 12
- rows_per_credit: 21.8
- remaining_credits: 112
- audit: AUDIT PASS
- timestamp: 2026-06-23T01:54:31Z

## Run: run_20260623_024152
- models_scraped: 28
- trusted_added: 216
- dup_skipped: 7
- credits_spent: 28
- rows_per_credit: 7.7
- remaining_credits: 84
- audit: AUDIT PASS
- timestamp: 2026-06-23T02:43:37Z

## Run: run_20260623_024339
- models_scraped: 18
- trusted_added: 270
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 9.6
- remaining_credits: 54
- audit: AUDIT PASS
- timestamp: 2026-06-23T02:45:00Z

## Run: run_20260623_024502
- models_scraped: 28
- trusted_added: 516
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 18.4
- remaining_credits: 26
- audit: AUDIT PASS
- timestamp: 2026-06-23T02:47:05Z

## Run: run_20260623_024707
- models_scraped: 24
- trusted_added: 383
- dup_skipped: 0
- credits_spent: 24
- rows_per_credit: 16.0
- remaining_credits: 2
- audit: AUDIT PASS
- timestamp: 2026-06-23T02:48:40Z

## Run: run_20260623_031151
- models_scraped: 10
- trusted_added: 74
- dup_skipped: 0
- credits_spent: 10
- rows_per_credit: 7.4
- remaining_credits: 1014
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:12:29Z

## Run: run_20260623_031642
- models_scraped: 1
- trusted_added: 42
- dup_skipped: 1
- credits_spent: 1
- rows_per_credit: 42.0
- remaining_credits: 1012
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:17:04Z

## Run: run_20260623_031706
- models_scraped: 6
- trusted_added: 77
- dup_skipped: 0
- credits_spent: 6
- rows_per_credit: 12.8
- remaining_credits: 1006
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:17:40Z

## Run: run_20260623_031743
- models_scraped: 28
- trusted_added: 441
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 15.8
- remaining_credits: 978
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:19:41Z

## Run: run_20260623_031943
- models_scraped: 28
- trusted_added: 336
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 12.0
- remaining_credits: 950
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:22:13Z

## Run: run_20260623_032216
- models_scraped: 28
- trusted_added: 512
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 18.3
- remaining_credits: 922
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:24:27Z

## Run: run_20260623_032431
- models_scraped: 28
- trusted_added: 346
- dup_skipped: 5
- credits_spent: 28
- rows_per_credit: 12.4
- remaining_credits: 894
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:26:30Z

## Run: run_20260623_032634
- models_scraped: 13
- trusted_added: 122
- dup_skipped: 0
- credits_spent: 13
- rows_per_credit: 9.4
- remaining_credits: -1
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:27:47Z

## Run: run_20260623_032749
- models_scraped: 28
- trusted_added: 407
- dup_skipped: 3
- credits_spent: 28
- rows_per_credit: 14.5
- remaining_credits: 852
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:29:39Z

## Run: run_20260623_032941
- models_scraped: 28
- trusted_added: 269
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 9.6
- remaining_credits: 824
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:32:19Z

## Run: run_20260623_033221
- models_scraped: 28
- trusted_added: 265
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 9.5
- remaining_credits: 796
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:33:56Z

## Run: run_20260623_033359
- models_scraped: 26
- trusted_added: 512
- dup_skipped: 1
- credits_spent: 26
- rows_per_credit: 19.7
- remaining_credits: 770
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:35:49Z

## Run: run_20260623_033552
- models_scraped: 28
- trusted_added: 397
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 14.2
- remaining_credits: 742
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:37:47Z

## Run: run_20260623_033750
- models_scraped: 28
- trusted_added: 299
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 10.7
- remaining_credits: 714
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:39:33Z

## Run: run_20260623_033936
- models_scraped: 28
- trusted_added: 410
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 14.6
- remaining_credits: 686
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:41:21Z

## Run: run_20260623_034124
- models_scraped: 14
- trusted_added: 313
- dup_skipped: 0
- credits_spent: 14
- rows_per_credit: 22.4
- remaining_credits: 671
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:42:53Z

## Run: run_20260623_034256
- models_scraped: 28
- trusted_added: 209
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 7.5
- remaining_credits: 643
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:44:46Z

## Run: run_20260623_034449
- models_scraped: 28
- trusted_added: 262
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 9.4
- remaining_credits: 615
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:46:28Z

## Run: run_20260623_034631
- models_scraped: 4
- trusted_added: 8
- dup_skipped: 0
- credits_spent: 4
- rows_per_credit: 2.0
- remaining_credits: 611
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:46:55Z

## Run: run_20260623_035716
- models_scraped: 28
- trusted_added: 307
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 11.0
- remaining_credits: 583
- audit: AUDIT PASS
- timestamp: 2026-06-23T03:59:00Z

## Run: run_20260623_035903
- models_scraped: 16
- trusted_added: 136
- dup_skipped: 1
- credits_spent: 16
- rows_per_credit: 8.5
- remaining_credits: 566
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:00:27Z

## Run: run_20260623_040029
- models_scraped: 28
- trusted_added: 622
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 22.2
- remaining_credits: 538
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:04:02Z

## Run: run_20260623_040404
- models_scraped: 8
- trusted_added: 143
- dup_skipped: 0
- credits_spent: 8
- rows_per_credit: 17.9
- remaining_credits: 530
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:04:34Z

## Run: run_20260623_040436
- models_scraped: 28
- trusted_added: 618
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 22.1
- remaining_credits: 502
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:06:49Z

## Run: run_20260623_040651
- models_scraped: 28
- trusted_added: 549
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 19.6
- remaining_credits: 474
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:08:53Z

## Run: run_20260623_040855
- models_scraped: 28
- trusted_added: 497
- dup_skipped: 3
- credits_spent: 28
- rows_per_credit: 17.8
- remaining_credits: 446
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:10:51Z

## Run: run_20260623_041053
- models_scraped: 28
- trusted_added: 485
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 17.3
- remaining_credits: 418
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:12:34Z

## Run: run_20260623_041236
- models_scraped: 28
- trusted_added: 355
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 12.7
- remaining_credits: 390
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:14:23Z

## Run: run_20260623_041425
- models_scraped: 28
- trusted_added: 471
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 16.8
- remaining_credits: 362
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:16:57Z

## Run: run_20260623_041659
- models_scraped: 28
- trusted_added: 602
- dup_skipped: 9
- credits_spent: 28
- rows_per_credit: 21.5
- remaining_credits: 334
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:19:12Z

## Run: run_20260623_041917
- models_scraped: 28
- trusted_added: 621
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 22.2
- remaining_credits: 306
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:21:04Z

## Run: run_20260623_042107
- models_scraped: 22
- trusted_added: 426
- dup_skipped: 0
- credits_spent: 22
- rows_per_credit: 19.4
- remaining_credits: 283
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:22:34Z

## Run: run_20260623_042236
- models_scraped: 14
- trusted_added: 166
- dup_skipped: 0
- credits_spent: 14
- rows_per_credit: 11.9
- remaining_credits: 269
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:23:25Z

## Run: run_20260623_042327
- models_scraped: 28
- trusted_added: 896
- dup_skipped: 3
- credits_spent: 28
- rows_per_credit: 32.0
- remaining_credits: 241
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:25:12Z

## Run: run_20260623_042514
- models_scraped: 28
- trusted_added: 627
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 22.4
- remaining_credits: 213
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:26:53Z

## Run: run_20260623_042655
- models_scraped: 28
- trusted_added: 552
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 19.7
- remaining_credits: 185
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:28:37Z

## Run: run_20260623_042839
- models_scraped: 28
- trusted_added: 832
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 29.7
- remaining_credits: 157
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:31:07Z

## Run: run_20260623_043109
- models_scraped: 28
- trusted_added: 778
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 27.8
- remaining_credits: 129
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:33:04Z

## Run: run_20260623_043306
- models_scraped: 28
- trusted_added: 408
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 14.6
- remaining_credits: 101
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:35:05Z

## Run: run_20260623_043507
- models_scraped: 28
- trusted_added: 406
- dup_skipped: 0
- credits_spent: 28
- rows_per_credit: 14.5
- remaining_credits: 73
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:37:18Z

## Run: run_20260623_043720
- models_scraped: 28
- trusted_added: 631
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 22.5
- remaining_credits: 45
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:38:57Z

## Run: run_20260623_043859
- models_scraped: 24
- trusted_added: 269
- dup_skipped: 1
- credits_spent: 24
- rows_per_credit: 11.2
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:40:47Z

## Run: run_20260623_044050
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:40:51Z

## Run: run_20260623_044054
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:40:55Z

## Run: run_20260623_044058
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:40:59Z

## Run: run_20260623_044101
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:41:03Z

## Run: run_20260623_044105
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:41:07Z

## Run: run_20260623_044109
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:41:10Z

## Run: run_20260623_044112
- models_scraped: 0
- trusted_added: 0
- dup_skipped: 0
- credits_spent: 0
- rows_per_credit: 0.0
- remaining_credits: 21
- audit: AUDIT PASS
- timestamp: 2026-06-23T04:41:13Z

## Run: run_20260623_051150
- models_scraped: 28
- trusted_added: 477
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 17.0
- remaining_credits: 997
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:13:43Z

## Run: run_20260623_051345
- models_scraped: 28
- trusted_added: 546
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 19.5
- remaining_credits: 969
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:15:45Z

## Run: run_20260623_051548
- models_scraped: 28
- trusted_added: 411
- dup_skipped: 1
- credits_spent: 28
- rows_per_credit: 14.7
- remaining_credits: 941
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:17:48Z

## Run: run_20260623_051751
- models_scraped: 28
- trusted_added: 381
- dup_skipped: 3
- credits_spent: 28
- rows_per_credit: 13.6
- remaining_credits: 913
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:19:37Z

## Run: run_20260623_051940
- models_scraped: 28
- trusted_added: 177
- dup_skipped: 3
- credits_spent: 28
- rows_per_credit: 6.3
- remaining_credits: 885
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:21:27Z

## Run: run_20260623_052130
- models_scraped: 20
- trusted_added: 168
- dup_skipped: 2
- credits_spent: 20
- rows_per_credit: 8.4
- remaining_credits: 864
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:23:00Z

## Run: run_20260623_052303
- models_scraped: 28
- trusted_added: 262
- dup_skipped: 2
- credits_spent: 28
- rows_per_credit: 9.4
- remaining_credits: 836
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:24:37Z

## Run: run_20260623_052439
- models_scraped: 28
- trusted_added: 339
- dup_skipped: 6
- credits_spent: 28
- rows_per_credit: 12.1
- remaining_credits: 808
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:26:24Z

## Run: run_20260623_052627
- models_scraped: 14
- trusted_added: 177
- dup_skipped: 2
- credits_spent: 14
- rows_per_credit: 12.6
- remaining_credits: 794
- audit: AUDIT PASS
- timestamp: 2026-06-23T05:27:22Z

## QA CHECKPOINT @ 1007 rows
- verdict: PASS
- corpus_total: 23895
- timestamp: 2026-06-23T06:46:28Z

## QA CHECKPOINT @ 1026 rows
- verdict: PASS
- corpus_total: 25769
- timestamp: 2026-06-23T07:09:41Z
