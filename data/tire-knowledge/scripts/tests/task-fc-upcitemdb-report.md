# Firecrawl UPCitemdb Harvester — Task Report

## What Was Built

### `scripts/upcitemdb_firecrawl_harvest.py`

A Firecrawl-proxy harvester that replaces the free `requests` scraper for
upcitemdb brand pages. The free scraper gets HTTP 429 (rate-limited); Firecrawl
uses rotating proxy IPs to bypass it.

Key behaviors:

- **Incremental skip**: shares `harvested_brands.json` with the existing
  `upcitemdb_harvest.py`. Any brand already in that file is skipped without
  spending credits.
- **All Firecrawl calls through the credit firewall**: uses
  `firecrawl_client.call(["scrape","--format","html","--proxy","auto", url],
  expected_max_credits=2, run_state, root=ROOT)`. Per-run cap and total-lifetime
  cap are enforced by `firecrawl_client`.
- **Parse and write**: HTML output is parsed with `upcitemdb_parse.parse_page`,
  each row gets `evidence_level="verified_db"` and `source_url` set, then
  written via `write_outputs.write_rows`.
- **Mark done**: brand is written to `harvested_brands.json` after a successful
  scrape (>=0 parsed rows). Failed scrapes (rc!=0 or empty stdout) are NOT
  marked done so they retry next run.
- **Cap/kill switch error handling**: `RuntimeError` from `firecrawl_client.call`
  (cap exceeded or kill switch active) is caught cleanly; harvest finalizes
  ledger + audit and returns a result dict without re-raising.

### Efficiency Floor

After a **warmup of 5 scraped brands**, the harvester checks:

```
cumulative_rows_per_credit = trusted_added / max(1, credits_spent_total)
```

If this ratio is below **8 rows/credit**, the run stops immediately and returns
`stopped_low_efficiency=True`. The check uses only brands that were actually
scraped (not skipped brands).

Rationale: each `info-{brand}_tires` page yields ~45 rows at 1 credit. If we
are getting fewer than 8 rows/credit, either the pages are being blocked despite
the proxy, or the content is very sparse — not worth continuing at that cost.

### Checkpoint Logic (every 2,000 new trusted rows)

Two steps fire each time the cumulative trusted row count crosses a multiple of
2,000:

1. **`verify_corpus_full.py`** (free, deterministic) via subprocess. Output is
   checked for `"ALL DETERMINISTIC CHECKS PASS"`. If it fails, harvest stops
   immediately (`qa_aborted=True`).

2. **`gemini_verify_sample.py --n 25 --seed <varying>`** (~$1 per checkpoint,
   grounded Gemini calls) via subprocess. Advisory only — yes/no/uncertain counts
   are logged to `run-log.md` under `## CHECKPOINT @ N rows`. Does NOT stop the
   harvest regardless of results.

The seed varies per checkpoint (`42 + checkpoint_number`) to sample different
rows each time.

### `crossed_2000` helper

```python
def crossed_2000(prev: int, now: int) -> bool:
    if now <= prev:
        return False
    return (now // 2000) > (prev // 2000)
```

Mirrors the existing `crossed_1000` from `upcitemdb_harvest.py` but at the
2,000-row interval.

---

## Fixture

`scripts/tests/fixtures/upcitemdb_fortune.html` — already existed with ~44
Fortune tire entries in real `<div class="rImage">` format. No new fixture was
needed.

---

## Test Results

### New test file: `scripts/tests/test_upcitemdb_fc_harvest.py`

21 tests, all offline (no network, no Firecrawl credits). `firecrawl_client.call`
is monkeypatched in every test.

| Test | Assertion |
|------|-----------|
| `test_happy_path_trusted_rows_and_harvested_brands` | trusted_added > 0, rows_per_credit correct, harvested_brands.json updated, audit_ok True |
| `test_happy_path_all_rows_have_verified_db_evidence` | every flat CSV row has evidence_level=verified_db |
| `test_happy_path_source_url_set_correctly` | every row source_url == upcitemdb brand page URL |
| `test_happy_path_rows_per_credit_multiple_brands` | rows_per_credit = trusted_added / credits_spent over 2 brands |
| `test_efficiency_floor_stops_after_warmup` | empty page + 5 brands -> stopped_low_efficiency=True, stops at exactly 5 calls |
| `test_efficiency_floor_not_triggered_before_warmup` | < 5 brands scraped -> no floor trigger |
| `test_efficiency_floor_not_triggered_when_yield_is_high` | fixture HTML (many rows) -> no floor trigger |
| `test_crossed_2000_*` (10 tests) | boundary helper correctness at 0/1999/2000/2001/3999/4000/4100, same-band no-trigger, decreasing no-trigger, zero delta |
| `test_firecrawl_runtime_error_caught_cleanly` | RuntimeError from call() caught cleanly, returns result dict |
| `test_incremental_skip_brand_already_done` | brand in harvested_brands.json -> call() never invoked |
| `test_incremental_idempotent_second_run` | second run skips brand, call() not called again |
| `test_failed_scrape_not_marked_done` | rc=1 from call() -> brands_missed incremented, brand NOT in harvested_brands.json |

### Full suite

```
189 passed in 32.99s
```

168 pre-existing tests + 21 new tests — all pass. No regressions.

---

## Proof Type

- **Automated proof**: all 21 tests run offline against the real harvester logic
  (monkeypatched Firecrawl call only)
- **Mocked proof**: `firecrawl_client.call` is monkeypatched; no live Firecrawl
  calls were made; no credits spent
- **Live proof**: not applicable (explicitly excluded per task instructions)

---

## Files Changed

| File | Action |
|------|--------|
| `scripts/upcitemdb_firecrawl_harvest.py` | Created — Firecrawl harvester |
| `scripts/tests/test_upcitemdb_fc_harvest.py` | Created — 21 offline tests |
| `scripts/tests/task-fc-upcitemdb-report.md` | Created — this report |

No existing files were modified. The existing corpus (26,241 rows) and the
168-test suite are fully preserved.
