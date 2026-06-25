# Tire Barcode Harvester — Claude Code Handoff

## What This Project Does

Builds a 30,000-row verified tire barcode database in CSV format, used as seed data for the
Smart Inventory Scanner app (`C:\Users\djsan\inventory`). The scanner is a private web app
(Next.js 16 + React 19) where a barcode scanner acts like a keyboard. When a tire barcode is
scanned, the app must instantly resolve it to a known product. This CSV is the training corpus
that powers deterministic lookup.

**Target:** 30,000 trusted UPC/EAN/GTIN barcode rows across all major tire brands and sizes.
**Batch size:** ~250 trusted rows per run.
**Run cadence:** Every 2 hours (automated via Windows Task Scheduler — see section below).
**Paid API constraint:** ZERO paid API calls. No Gemini, OpenAI, Anthropic, Firecrawl, or
any other pay-per-use service. All harvesting uses free public web pages.

---

## File Tree — Everything Created So Far

```
C:\Users\djsan\inventory\data\tire-knowledge\
│
├── CLAUDE_CODE_HANDOFF.md          ← this file
│
├── tire_corpus_flat.csv            ← MAIN OUTPUT (20-column v3 schema, 0 data rows so far)
├── tire_products.csv               ← support table (headers only)
├── tire_identifiers.csv            ← support table (headers only)
├── tire_size_aliases.csv           ← support table (headers only)
├── tire_brand_aliases.csv          ← support table (headers only)
├── tire_model_aliases.csv          ← support table (headers only)
├── tire_sources.csv                ← support table (headers only)
├── tire_enrichment_backlog.csv     ← items needing more data (headers only)
├── rejected_rows.csv               ← rows that failed validation (headers only)
├── blocked_sources.csv             ← domains that consistently fail (headers only)
│
├── coverage_ledger.json            ← tracks seen barcodes, identity keys, completed cells
├── current_run_progress.json       ← resumable run state
├── harvest.lock                    ← process lock (delete this before first run)
├── run-log.md                      ← human-readable run history
│
├── scripts/
│   ├── validate.py                 ← COMPLETE: all validation + normalization utilities
│   ├── process_amazon.py           ← COMPLETE: Amazon page parser + corpus writer
│   ├── asin_list.json              ← raw ASIN search results from 9 Amazon searches
│   └── asins_to_harvest.txt        ← 168 deduplicated ASINs ready to visit
│
└── outputs/
    └── archive/                    ← past run artifacts go here
```

---

## Current State

- `tire_corpus_flat.csv` has headers but **0 data rows** — harvesting has not started yet
- `asins_to_harvest.txt` has **168 ASINs** ready to visit, collected from 9 Amazon searches
- `validate.py` is fully built and all validation tests pass
- `process_amazon.py` is fully built and tested (verified with a real Falken ASIN)
- `harvest.lock` is stale from a previous interrupted session — **delete it before running**

---

## tire_corpus_flat.csv Schema (v3 — 20 columns)

```
canonical_product_uid      # brand_model_size_load_speed_mpn (stable, lowercase, underscores)
brand                      # normalized brand name (e.g. "falken", "michelin")
model                      # normalized model name (e.g. "wildpeak_a_t4w")
size_canonical             # e.g. "LT275/70R18", "P225/65R17", "33x12.50R20"
size_compact               # e.g. "2757018", "2256517" (for fast matching)
load_index                 # e.g. "125" (string, not int)
speed_rating               # e.g. "S"
tire_type                  # "All Terrain", "Highway", "Mud Terrain", etc.
season                     # "All Season", "Winter", "Summer", "All Weather"
barcode                    # 12-14 digit UPC/EAN/GTIN string
barcode_type               # "upc", "ean", "gtin14"
manufacturer_part_number   # MPN / OEM part number (optional)
source_url                 # exact Amazon product URL (or other source)
evidence_level             # "verified_1src_strong", "verified_1src_snippet", "suggested"
usable_for                 # "auto_count_candidate" | "review_required" | "backlog_only"
current_status             # "active_retail", "discontinued", "unknown"
missing_fields             # comma-separated list of missing optional fields
field_completeness_score   # 0.0–1.0 float
harvested_at               # ISO 8601 timestamp
run_id                     # e.g. "run_20260622_001"
```

---

## The Proven Harvesting Approach (Amazon)

Amazon is the confirmed working UPC source. All other sites tested failed:
- Priority Tire: shows MPN but NOT UPC on product pages
- SimpleTire: 404s on direct product URLs
- Falken/Cooper manufacturer sites: JS-rendered, returns empty HTML
- Discount Tire: no structured JSON-LD data

**How Amazon UPC extraction works:**

1. Search Amazon for a tire size (e.g. `https://www.amazon.com/s?k=225+65R17+tires`)
2. Use JavaScript on the search results page to collect ASINs from `[data-asin]` elements
3. Visit each product page: `https://www.amazon.com/dp/{ASIN}`
4. Extract UPC from the product details table — it appears as literal text:
   `UPC</th><td class="a-size-base prodDetAttrValue">848983026514`
5. Also extract: brand, model name, tire size, load index, speed rating from the page title
   and the product detail table rows

**Proven JS extract (use this in Playwright):**

```javascript
// On a product page — returns UPC and key details
const details = {};
document.querySelectorAll('.prodDetAttrValue').forEach((td, i) => {
  const th = document.querySelectorAll('.prodDetSectionEntry')[i];
  if (th) details[th.innerText.trim()] = td.innerText.trim();
});
const upc = details['UPC'] || details['EAN'] || null;
const title = document.querySelector('#productTitle')?.innerText?.trim() || '';
return { title, upc, details };
```

---

## What Claude Code Needs to Build

### 1. Main Harvest Script: `scripts/harvest_amazon.py`

A standalone Python script that:

1. Reads `scripts/asins_to_harvest.txt` (168 ASINs, one per line)
2. Loads `coverage_ledger.json` to skip already-seen barcodes
3. For each ASIN not already harvested:
   - Opens the Amazon product page (`https://www.amazon.com/dp/{ASIN}`)
   - Extracts UPC, title, and product details using Playwright (headless Chromium)
   - Calls `process_amazon.py`'s `parse_product()` to validate and structure the data
   - Appends trusted rows to `tire_corpus_flat.csv`
   - Appends backlog rows to `tire_enrichment_backlog.csv`
   - Appends rejected rows to `rejected_rows.csv`
4. Updates `coverage_ledger.json` with newly seen barcodes and identity keys
5. Writes a run summary to `run-log.md`
6. Cleans up `harvest.lock` on exit

**Key requirements:**
- Use `playwright` Python library (not `requests` — Amazon blocks raw HTTP)
- Headless Chromium with a realistic User-Agent header
- 2–4 second random delay between page visits (be polite, avoid blocks)
- Skip ASINs whose barcode is already in `coverage_ledger.json["seen_barcodes"]`
- Resume-safe: if interrupted, re-running picks up where it left off
- Write `harvest.lock` with a heartbeat timestamp at start; delete on clean exit

**Playwright install:**
```bash
pip install playwright
playwright install chromium
```

### 2. ASIN Expansion Script: `scripts/collect_asins.py`

A script that searches Amazon for more tire sizes and collects more ASINs.

Target tire sizes to add (after the 9 already collected):
```
205/55R16, 215/60R16, 225/60R16, 225/60R17, 235/60R17, 245/65R17
LT245/75R16, LT265/75R16, LT285/75R16, LT315/70R17
255/70R16, 265/65R17, 275/55R20, 285/45R22
11R22.5, 11R24.5, 295/75R22.5 (commercial)
```

For each size:
- Navigate to `https://www.amazon.com/s?k={size_url_encoded}+tires`
- Collect all `[data-asin]` values from product cards
- Deduplicate against `asins_to_harvest.txt`
- Append new ASINs to `asins_to_harvest.txt`

### 3. Windows Task Scheduler Setup

Set up an automated run every 2 hours using Windows Task Scheduler.

**Create a wrapper batch file: `scripts/run_harvest.bat`**
```batch
@echo off
cd /d C:\Users\djsan\inventory\data\tire-knowledge
python scripts\harvest_amazon.py >> outputs\harvest_cron.log 2>&1
```

**Register with Task Scheduler (run this once in PowerShell as Administrator):**
```powershell
$action = New-ScheduledTaskAction `
  -Execute "C:\Users\djsan\inventory\data\tire-knowledge\scripts\run_harvest.bat"

$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 2) -Once `
  -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 90) `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
  -TaskName "TireBarcodeHarvester" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Runs the tire barcode harvester every 2 hours"
```

**Or use Python `schedule` library as an alternative (no admin needed):**
```python
# scripts/scheduler.py
import schedule, time, subprocess, sys

def run_harvest():
    result = subprocess.run(
        [sys.executable, 'scripts/harvest_amazon.py'],
        cwd='C:/Users/djsan/inventory/data/tire-knowledge',
        capture_output=True, text=True
    )
    print(result.stdout)
    if result.returncode != 0:
        print("ERROR:", result.stderr)

schedule.every(2).hours.do(run_harvest)
run_harvest()  # run immediately on start

while True:
    schedule.run_pending()
    time.sleep(60)
```

### 4. Expand Sources Beyond Amazon

Once Amazon ASINs are exhausted, add these free sources:

**a) Open Product Data / Open Food Facts spin-offs:**
- `https://world.openfoodfacts.org/` — food only, skip
- `https://www.barcodelookup.com/` — has tire barcodes, free tier with rate limits
  - URL pattern: `https://www.barcodelookup.com/{barcode}`

**b) Tire manufacturer catalog pages (use Playwright — JS-rendered):**
- `https://www.falken.com/tires/` — navigate by size/product
- `https://www.coopertire.com/tires/` — has product detail pages
- `https://www.continentaltire.com/tires/` — product pages include EAN
- `https://www.bridgestonetire.com/tires/` — structured product data

**c) Retailer product listing pages (Playwright required):**
- `https://www.tirerack.com/tires/` — search by size, product cards include UPC
- `https://www.discounttire.com/buy-tires/` — category pages (not search)

**d) Public barcode databases:**
- `https://www.digit-eyes.com/` — API-free lookup via URL pattern
- `https://www.buycott.com/upc/` — community UPC database

### 5. Improvements to Existing Scripts

**`scripts/validate.py`** — already solid, minor improvements:
- Add `extract_load_speed_from_title(title: str)` that handles more title formats
  (e.g. "Falken Wildpeak AT4W LT275/70R18 125/122S" → load=125, speed=S)
- Add confidence scoring for the size parse (some titles have malformed sizes)
- Add `is_passenger_tire()`, `is_light_truck()`, `is_commercial()` classification

**`scripts/process_amazon.py`** — works but add:
- Better model name extraction (strip brand prefix, size suffix, load/speed from title)
- Handle EAN-13 as well as UPC-12 (some European tires on Amazon list EAN)
- Handle cases where UPC appears in `#productDetails_techSpec_section_1` vs the main table
- Extract `tire_type` from product bullet points (look for "All Terrain", "Highway", etc.)
- Extract `season` from bullet points (look for "All Season", "Winter", etc.)

---

## Key Code in validate.py (already working — do not break)

```python
# GTIN check digit — right-to-left weights 3,1,3,1...
def gtin_check_digit_valid(barcode: str) -> bool:
    b = barcode.strip()
    if not b.isdigit(): return False
    if len(b) not in (8, 12, 13, 14): return False
    if len(set(b)) == 1: return False
    digits = [int(c) for c in b]
    total = 0
    for i, d in enumerate(reversed(digits[:-1])):
        weight = 3 if i % 2 == 0 else 1
        total += d * weight
    computed = (10 - (total % 10)) % 10
    return computed == digits[-1]

# Size → (canonical, compact)
# P225/65R17 → ("P225/65R17", "2256517")
# 33x12.50R20 → ("33x12.50R20", "33125020")
# 11R22.5 → ("11R22.5", "11225")
def normalize_size(raw: str) -> tuple: ...

# Stable product UID
def make_uid(brand, model, size_canonical, load_index='', speed_rating='', mpn='') -> str: ...
```

---

## coverage_ledger.json Structure

```json
{
  "schema_version": "3.0",
  "total_trusted_barcode_rows": 0,
  "seen_barcodes": ["848983026514", ...],
  "seen_part_numbers": [],
  "seen_identity_keys": ["falken|wildpeak_a_t4w|LT275/70R18|125|S|B0CR68NPLC", ...],
  "runs": [
    {
      "run_id": "run_20260622_001",
      "started_at": "...",
      "completed_at": "...",
      "trusted_added": 0,
      "backlog_added": 0,
      "rejected": 0,
      "sources_attempted": []
    }
  ]
}
```

---

## Rules Claude Code Must Follow

1. **Zero paid APIs.** No Gemini, OpenAI, Anthropic, Firecrawl, SerpAPI, or any pay-per-use
   service. All data comes from free public web pages scraped with Playwright.

2. **Idempotent writes.** Every run is safe to re-run. Check `seen_barcodes` before inserting.
   Same barcode never appears twice in `tire_corpus_flat.csv`.

3. **validate.py is the single source of truth** for check-digit validation, size normalization,
   UID generation, and completeness scoring. Do not duplicate this logic elsewhere.

4. **Unknown is acceptable; wrong is not.** If a barcode can't be validated or a product can't
   be identified clearly, route to `tire_enrichment_backlog.csv`. Never invent data.

5. **Be polite to Amazon.** 2–4 second random delay between requests. If a CAPTCHA is detected
   (page title contains "Robot Check" or "CAPTCHA"), stop the run, log it, and exit gracefully.

6. **Lock file discipline.** Write `harvest.lock` before starting; delete it on clean exit.
   Treat a lock older than 90 minutes as stale and delete it before starting a new run.

7. **Never touch the inventory app source files.** Only touch files inside
   `C:\Users\djsan\inventory\data\tire-knowledge\`. The scanner app is in the parent directory.

---

## Python Environment

The project is inside a Next.js monorepo. Python scripts run standalone:
```bash
cd C:\Users\djsan\inventory\data\tire-knowledge

# Install dependencies (one time)
pip install playwright pandas python-dateutil schedule
playwright install chromium

# Delete stale lock before first run
del harvest.lock

# Run harvest manually
python scripts\harvest_amazon.py

# Run scheduler (keeps running every 2 hours)
python scripts\scheduler.py
```

---

## Claude Code Tools Available (Use These to Improve the Harvester)

Claude Code has access to:
- **Playwright MCP** — if connected, prefer it over subprocess Playwright for browser control
- **GitHub MCP** — for checking if there are community tire barcode datasets in public repos
- **Web search** — to research new free tire data sources
- **Bash tool** — to run the Python scripts directly and verify output
- **File read/write** — to inspect and improve the CSV and JSON files

When improving the pipeline, consider:
- Can you find a public GTIN/UPC dataset for tires? (e.g. Open Product Data, UPC Database dumps)
- Can you parallelize ASIN visits with `asyncio` + `async playwright`?
- Can you add a `--dry-run` flag that validates without writing?
- Can you add a progress bar (tqdm) for the ASIN loop?

---

## Definition of Done (for Claude Code)

- [ ] `harvest_amazon.py` runs end-to-end and writes at least 50 real rows to `tire_corpus_flat.csv`
- [ ] Each row has a valid GTIN check digit (verified by `gtin_check_digit_valid()`)
- [ ] Re-running the script 3 times produces no duplicate barcodes in the CSV
- [ ] `coverage_ledger.json` reflects accurate counts after each run
- [ ] Windows Task Scheduler task is registered and confirmed with `Get-ScheduledTask -TaskName "TireBarcodeHarvester"`
- [ ] `collect_asins.py` finds and appends at least 50 new ASINs from the expanded size list
- [ ] All tests in `validate.py` still pass after any changes to that file
- [ ] No API keys used, no paid services called

---

*Handoff created: 2026-06-22. Owner: Santiago (djsanti88@gmail.com)*
*Built in Cowork mode; execution handed to Claude Code for efficiency.*
