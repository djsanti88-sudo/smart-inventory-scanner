# CoWork Verification Handoff — Tire Barcode Harvester build (Claude Code session)

**Date:** 2026-06-23
**Sandbox (everything below lives here, nothing was touched outside it):**
`C:\Users\djsan\inventory\data\tire-knowledge`
**Purpose of this doc:** Hand the full record of what Claude Code did to CoWork (or any reviewer) so it can independently verify before we continue.

---

## 0. TL;DR for the reviewer

- Built a local, credit-capped Firecrawl tire-barcode harvester through a brainstorm → spec → plan → subagent-driven build.
- **Milestone 1 (free, 0 credits)** and **Milestone 2 core (live, 8 credits)** are DONE and independently verified.
- **Current corpus: 158 verified rows** (100 free seed + 58 live-harvested), 158 unique barcodes, **0 invalid GTINs**, 17 brands.
- **77 automated tests pass. `audit_corpus.py` = AUDIT PASS.**
- **Firecrawl credits: 8 of 50-cap spent; 152 remaining.**
- No git commits, no app code touched, no deploy, no fake proof. URL-parsing + GTIN validation are the trust basis.
- Deferred (NOT built): Task 10 enrichment (load/speed/season), Task 12 scheduler (inert), Task 13 Gemini QA gate.

---

## 1. What was decided (the 6 locked design choices)

1. **Strategy:** Phase A = tiresandwheels.com first; Phase B = multisource later.
2. **Quality bar for a trusted row:** valid GTIN barcode + (MPN or SKU) + brand + model + size. load/speed/season are optional (enrichment).
3. **Credit cap:** TOTAL 50, PER-RUN 15, kill switch, ~110 reserve.
4. **Verification:** `verified_1src_strong` from URL-encoded UPC + GTIN check; Phase B cross-checks for free.
5. **Automation:** manual now; scheduler built later but disabled.
6. **Gemini QA:** deferred but gated (off by default).

Full design rationale: `HARVESTER_SPEC_v4.md`. Full task plan: `HARVESTER_PLAN_v4.md`.

---

## 2. KEY DISCOVERY (important for the reviewer to validate)

The original plan assumed `firecrawl map` would enumerate the product catalog cheaply. **It does not** — mapping the homepage returned only ~101 navigation URLs. The working path that was discovered and adopted:

- `robots.txt` → `sitemap_index.xml` → **`tirecatalog_prt1.xml.gz`** lists **1,375 tire MODEL pages** (`/catalog/tires/{Brand}/{Code}/{Model}/`). Fetching the sitemap is **FREE** (plain HTTPS, not Firecrawl).
- Barcodes are NOT in any sitemap. They live on **product pages** (`/product/tire/.../{BARCODE}_{SIZE}`), reachable only by **scraping a model page** (1 credit) which lists that model's size variants as product links.
- Each product URL encodes brand + MPN + retailer SKU + barcode + size, so the barcode is parsed from the URL for **0 credits** and then GTIN-validated.
- TLS note: tiresandwheels serves an **incomplete cert chain**, so the sitemap fetch uses an unverified SSL context (public read-only data; every barcode is GTIN-validated downstream).

**Measured economics:** ~10.8 verified rows per credit across the 5-model proof batch (a single rich model yielded 32; the single-model smoke run yielded 4). Reviewer should sanity-check this number.

---

## 3. Every file created or modified (all under the sandbox)

### Pipeline scripts — `scripts/`
| File | Bytes | Role | Status |
|---|---|---|---|
| `validate.py` | 9143 | GTIN/size/UID/scoring + `is_trusted_identity` | MODIFIED (added trusted-bar, gtin14 label, Windows utf-8 guard) |
| `parse_tiresandwheels_url.py` | 3215 | URL → identity (free); restores stripped leading-zero UPCs | CREATED |
| `ledger.py` | 1933 | coverage_ledger load/update/consistency | CREATED |
| `write_outputs.py` | 2755 | routing (trusted/backlog/rejected) + idempotent CSV writes | CREATED |
| `audit_corpus.py` | 1448 | schema/dup/GTIN/size/ledger audit | CREATED |
| `seed_from_example.py` | 1405 | Gate 0: import example rows free | CREATED |
| `firecrawl_client.py` | 8437 | CREDIT FIREWALL: caps, kill switch, fail-closed, Win-safe quoting | CREATED |
| `collect_sources.py` | 11925 | sitemap → model-page queue (free) | CREATED (rewritten from dead-end map version) |
| `harvest_tiresandwheels.py` | 7867 | scrape model pages → product URLs → parse → write | CREATED |
| `run_once.py` | 14290 | orchestrator: preflight + lock + collect→harvest→audit→log | CREATED |
| `process_amazon.py` | 12109 | (pre-existing from prior CoWork session) | UNCHANGED |

### Tests — `scripts/tests/` (all pass; run with `uv run python -m pytest scripts/tests/ -v`)
| File | Tests |
|---|---|
| `test_validate.py` | 6 |
| `test_parse_url.py` | 4 |
| `test_write_outputs.py` | 4 |
| `test_firecrawl_client.py` | 19 |
| `test_collect_sources.py` | 21 |
| `test_harvest.py` | 9 |
| `test_run_once.py` | 14 |
| **TOTAL** | **77 passed** |
| `fixtures/tire_c_1.csv` | the 100-row example, used as a regression fixture |
| `task-1..11-report.md` | per-task implementer reports (evidence trail) |

### Data / config / docs — sandbox root
| File | Note |
|---|---|
| `tire_corpus_flat.csv` | **MAIN OUTPUT — 158 data rows**, schema v3 (20 cols) |
| `tire_identifiers.csv` | 158 rows (barcode → retailer SKU) |
| `tire_model_queue.csv` | 1,375 model pages; **6 done / 1,369 queued** |
| `coverage_ledger.json` | seen barcodes/parts/identity keys/source URLs; counts |
| `firecrawl_policy.json` | caps + `total_credits_spent: 8` |
| `current_run_progress.json` | last run summary |
| `run-log.md` | human-readable run history incl. Gate 0 + batches |
| `firecrawl_policy.json` kill switch | create `.firecrawl_STOP` to abort all spend |
| `seed/TIRE_C_1.csv` | copy of the example used for the free seed |
| `tire_enrichment_backlog.csv` / `rejected_rows.csv` / `blocked_sources.csv` | currently 0 rows |
| `HARVESTER_SPEC_v4.md` / `HARVESTER_PLAN_v4.md` / `HARVESTER_PROGRESS.md` | design / plan / progress ledger |
| `CLAUDE_CODE_HANDOFF.md` | pre-existing (older Amazon-first handoff; now superseded by spec v4) |

---

## 4. Current verified state (outputs)

```
audit_corpus.py            : AUDIT PASS
pytest scripts/tests/      : 77 passed
tire_corpus_flat.csv rows  : 158
unique barcodes            : 158
invalid GTINs              : 0
distinct brands            : 17
rows from free seed        : 100 (run_id seed_example_001)
rows from live harvest     : 58 (run_id harvest_batch_001 = 54, run_* = 4)
Firecrawl credits spent    : 8 / 50 cap  (152 remaining)
harvest.lock present        : No (released cleanly)
model queue                : 6 done / 1369 queued
```

Credit ledger (8 total): 1 dead-end `map` (discovery) + 1 measurement scrape + 5 proof batch + 1 orchestrator smoke run.

---

## 5. How CoWork can INDEPENDENTLY verify (copy/paste)

Run from `C:\Users\djsan\inventory\data\tire-knowledge` (use `uv run python`, not bare `python`):

```bash
# 1. All tests
uv run python -m pytest scripts/tests/ -v

# 2. Corpus audit (schema, dup barcodes, dup UIDs, GTIN, size, ledger counts)
uv run python scripts/audit_corpus.py

# 3. Integrity spot-check
uv run python -c "import csv,sys; sys.path.insert(0,'scripts'); import validate as v; r=list(csv.DictReader(open('tire_corpus_flat.csv',encoding='utf-8'))); print('rows',len(r),'unique',len({x['barcode'] for x in r}),'badGTIN',sum(1 for x in r if not v.gtin_check_digit_valid(x['barcode'])))"

# 4. Credits actually remaining (live, free read)
uv run python -c "import sys; sys.path.insert(0,'scripts'); import firecrawl_client as fc; print('remaining', fc.get_remaining_credits())"

# 5. Prove a barcode parses from its own source URL (free, no scrape)
uv run python -c "import csv,sys; sys.path.insert(0,'scripts'); from parse_tiresandwheels_url import parse_url; r=list(csv.DictReader(open('tire_corpus_flat.csv',encoding='utf-8'))); bad=[x['barcode'] for x in r if (parse_url(x['source_url']) or {}).get('barcode')!=x['barcode']]; print('URL/barcode mismatches:', len(bad))"
```

Expected: 77 passed · AUDIT PASS · rows 158 / unique 158 / badGTIN 0 · remaining 152 · mismatches 0.

---

## 6. Known minor findings (logged, non-blocking)

- `parse_tiresandwheels_url.py`: a dead `\d{8}` regex branch + one cosmetic dead else-branch (no functional impact).
- `ledger.record_row`: a redundant dedup guard (write path already dedups).
- `write_outputs`: the `size_aliases` write path is not unit-tested (it is exercised but no dedicated test).
- These are recorded in `HARVESTER_PROGRESS.md` for a future cleanup/whole-branch review.

## 7. What is NOT done (deferred, by owner choice)

- **Task 10 — enrichment** (`enrich_listings.py`): fill load_index/speed_rating/season to raise completeness ~70→90. Scanner resolves rows without it.
- **Task 12 — scheduler** (`scheduler.py`, inert) and **Task 13 — Gemini QA gate** (`gemini_qa_batch.py`, gated off).
- **Phase B** (Amazon/multisource) — only after tiresandwheels is exhausted.

## 8. How to continue after verification

```bash
cd C:\Users\djsan\inventory\data\tire-knowledge
uv run python scripts/run_once.py --max-credits N   # N credits ≈ N*~11 verified rows
```
Emergency stop: create a file named `.firecrawl_STOP` in that folder.
```
```
