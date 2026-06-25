# Task: Brand-Diversity Queue Reorder — Report

## Status: COMPLETE

## Files Touched

- `scripts/collect_sources.py` — added `brand_of`, `interleave_by_brand`, `reorder_queue`; updated `collect()` to use `interleave_by_brand` when writing new queued URLs
- `scripts/tests/test_collect_sources.py` — added 19 new tests across `TestBrandOf`, `TestInterleaveByBrand`, `TestReorderQueue`

## Test Output

```
============================= test session starts =============================
platform win32 -- Python 3.13.13, pytest-9.0.3
collected 40 items

scripts/tests/test_collect_sources.py::TestIsModelPage::test_model_page_hankook PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_model_page_michelin PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_model_page_bridgestone PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_brand_index_hankook_excluded PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_brand_index_michelin_excluded PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_cart_excluded PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_root_excluded PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_catalog_root_excluded PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_other_domain_excluded PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_mixed_list_keeps_only_model_pages PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_exactly_four_segments_is_not_model PASSED
scripts/tests/test_collect_sources.py::TestIsModelPage::test_no_trailing_slash_still_works PASSED
scripts/tests/test_collect_sources.py::TestQueueIdempotency::test_writing_same_urls_twice_does_not_duplicate PASSED
scripts/tests/test_collect_sources.py::TestQueueIdempotency::test_partial_overlap_adds_only_new PASSED
scripts/tests/test_collect_sources.py::TestQueueIdempotency::test_empty_queue_file_created_with_header PASSED
scripts/tests/test_collect_sources.py::TestQueueIdempotency::test_load_queue_urls_returns_empty_set_when_file_absent PASSED
scripts/tests/test_collect_sources.py::TestQueueIdempotency::test_load_queue_urls_reads_existing_rows PASSED
scripts/tests/test_collect_sources.py::TestCollectMocked::test_fetch_sitemap_model_urls_filters_correctly PASSED
scripts/tests/test_collect_sources.py::TestCollectMocked::test_collect_queues_new_urls PASSED
scripts/tests/test_collect_sources.py::TestCollectMocked::test_collect_does_not_duplicate_on_second_run PASSED
scripts/tests/test_collect_sources.py::TestCollectMocked::test_collect_returns_zero_credits PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_extracts_hankook PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_extracts_michelin PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_extracts_bfgoodrich PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_lowercases_brand PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_empty_on_short_path PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_empty_on_non_catalog_url PASSED
scripts/tests/test_collect_sources.py::TestBrandOf::test_empty_on_garbage PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_round_robin_three_brands PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_no_brand_repeats_before_all_others_in_first_round PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_first_appearance_order_preserved PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_single_brand_unchanged PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_empty_list PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_internal_group_order_preserved PASSED
scripts/tests/test_collect_sources.py::TestInterleaveByBrand::test_no_data_loss_or_duplication PASSED
scripts/tests/test_collect_sources.py::TestReorderQueue::test_preserves_done_rows_at_top PASSED
scripts/tests/test_collect_sources.py::TestReorderQueue::test_preserves_total_count_and_url_set PASSED
scripts/tests/test_collect_sources.py::TestReorderQueue::test_queued_portion_is_interleaved PASSED
scripts/tests/test_collect_sources.py::TestReorderQueue::test_error_rows_preserved PASSED
scripts/tests/test_collect_sources.py::TestReorderQueue::test_returns_correct_brands_in_queue_count PASSED

40 passed in 0.09s
```

## reorder_queue() Result Dict

```python
{'total': 1375, 'kept': 46, 'queued': 1329, 'brands_in_queue': 62}
```

## First 20 Queued Rows After Reorder (brand | url)

1. Hankook | https://www.tiresandwheels.com/catalog/tires/Hankook/SC9735/Ventus-S1-evo3-SUV-K127C/
2. Nitto | https://www.tiresandwheels.com/catalog/tires/Nitto/SC351/Terra-Grappler/
3. General | https://www.tiresandwheels.com/catalog/tires/General/SC377/Grabber/
4. Kumho | https://www.tiresandwheels.com/catalog/tires/Kumho/SC497/Solus-KR21/
5. Pirelli | https://www.tiresandwheels.com/catalog/tires/Pirelli/SC6430/Cinturato-P1/
6. Falken | https://www.tiresandwheels.com/catalog/tires/Falken/SC515/FK-452/
7. Toyo | https://www.tiresandwheels.com/catalog/tires/Toyo/SC519/Proxes-R1R/
8. Federal | https://www.tiresandwheels.com/catalog/tires/Federal/SC12108/SS657/
9. BFGoodrich | https://www.tiresandwheels.com/catalog/tires/BFGoodrich/SC1330/All-Terrain-T/A-KO/
10. Nexen | https://www.tiresandwheels.com/catalog/tires/Nexen/SC1354/N3000/
11. Atturo | https://www.tiresandwheels.com/catalog/tires/Atturo/SC2004/Trail-Blade-A/T/
12. Mickey-Thompson-Tires | https://www.tiresandwheels.com/catalog/tires/Mickey-Thompson-Tires/SC2140/Deegan-38/
13. Lexani-Tire | https://www.tiresandwheels.com/catalog/tires/Lexani-Tire/SC2127/Mud-Beast-MT/
14. Dick-Cepek-Tires | https://www.tiresandwheels.com/catalog/tires/Dick-Cepek-Tires/SC2146/Fun-Country/
15. Fuel-Tires | https://www.tiresandwheels.com/catalog/tires/Fuel-Tires/SC2148/Mud-Gripper-MT/
16. Cooper | https://www.tiresandwheels.com/catalog/tires/Cooper/SC2940/Discoverer-STT-PRO/
17. Ironman | https://www.tiresandwheels.com/catalog/tires/Ironman/SC2946/All-Country-A/T/
18. Goodyear | https://www.tiresandwheels.com/catalog/tires/Goodyear/SC2947/Wrangler-DuraTrac/
19. Firestone | https://www.tiresandwheels.com/catalog/tires/Firestone/SC5099/Destination-M/T2/
20. Michelin | https://www.tiresandwheels.com/catalog/tires/Michelin/SC2959/Defender-LTX-M/S/

20 distinct brands in first 20 rows. No brand repeats in the first round.

## Data Safety Confirmation

- Total rows before: 1375 | Total rows after: 1375 — UNCHANGED
- Done rows preserved: 46 (status, order, and values unchanged)
- URL set: verified identical inside reorder_queue() by set equality assertion (raises ValueError if any URL is lost or gained)
- Queued rows reordered: 1329 across 62 distinct brands

## Firecrawl Credits

0 credits spent. No network calls made. Pure in-memory CSV reorder.

## Concerns

None. The implementation is deterministic (no randomness), stable (group-internal order preserved),
and safe (asserts total count and URL set equality before writing). Future calls to collect() will
also write new URLs in interleaved brand order.
