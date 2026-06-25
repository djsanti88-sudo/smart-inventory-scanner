# Phase B Implementation Plan — new barcode sources

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. NOTE: this session uses NO git commits — each task ends with a Checkpoint (run proof), not a commit.

**Goal:** Grow the tire-barcode corpus beyond tiresandwheels by finding new sources that expose GTINs cheaply (≥8 rows/credit bulk floor), plus a capped 100-credit niche-brand effort.

**Architecture:** A generic JSON-LD/microdata extractor pulls product GTINs from any page's raw HTML. A probe tool measures GTIN density (rows/credit) across candidate tire sites; only sources clearing ≥8/credit get a thin per-site harvest config that feeds the EXISTING pipeline (validate → dedup → enrich → route → audit → firewall). Niche brands use catalogs / barcode-API / Amazon-last-resort under a hard 100-credit cap.

**Tech Stack:** Python 3.13 stdlib (`json`, `re`, `csv`, `html.parser`), Firecrawl CLI via the existing `firecrawl_client.py` firewall, `pytest`.

## Global Constraints

- Sandbox only: `C:\Users\djsan\inventory\data\tire-knowledge`. No app code, no deploy, no git commits (Checkpoint instead).
- **Bulk floor (HARD): ≥8 rows/credit.** A source below it is not harvested.
- **Niche sub-budget: HARD cap 100 credits** (Blackhawk/Fortune/Arisun), any efficiency; Amazon only as last resort, most-sold sizes only.
- All Firecrawl calls go through `firecrawl_client.call(cmd_args, expected_max_credits, run_state)` (caps + kill switch + fail-closed). Run Python via `uv run python`.
- Reuse the pipeline: `validate` (GTIN check, size normalize, `is_trusted_identity`, `barcode_type_label`), `write_outputs.write_rows`, `ledger`, `audit_corpus`. Preserve leading zeros (barcodes are strings). Never invent data; no row dropped for missing enrichment. Treat scraped/API data as untrusted.
- Schema v3 unchanged (20 cols). Trusted bar: valid GTIN + (MPN or SKU) + brand + model + size.

## File Structure

```
scripts/
  structured_data.py        (CREATE) generic JSON-LD/microdata -> product dicts
  phaseb_probe.py           (CREATE) probe candidate sites, report rows/credit
  harvest_structured.py     (CREATE) generic harvester for a committed source (per-site config)
  catalog_parse.py          (CREATE, niche) Firecrawl parse of EAN/UPC catalog docs
  barcode_api_lookup.py     (CREATE, niche) brand+MPN -> UPC via barcode API
  tests/
    test_structured_data.py (CREATE)
    fixtures/jsonld_sample.html (CREATE)
```

---

# MILESTONE 1 — Probe (fully detailed; ~10–15 credits)

### Task 1: `structured_data.py` — generic GTIN extractor

**Files:**
- Create: `scripts/structured_data.py`
- Create: `scripts/tests/test_structured_data.py`
- Create: `scripts/tests/fixtures/jsonld_sample.html`

**Interfaces:**
- Produces: `extract_products(html: str) -> list[dict]` returning, for each Product found in JSON-LD, `{"name","brand","mpn","sku","gtin","offers_count"}` (missing fields = ""). `gtin` = first present of gtin13/gtin12/gtin14/gtin/gtin8.

- [ ] **Step 1: Create the fixture** `scripts/tests/fixtures/jsonld_sample.html` containing a realistic product JSON-LD block:
```html
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Fortune Tormenta A/T FSR308 265/70R17",
 "brand":{"@type":"Brand","name":"Fortune"},"mpn":"FSR308-2657017","sku":"FT12345",
 "gtin13":"6970018810017","offers":{"@type":"Offer","price":"129.99"}}
</script>
<script type="application/ld+json">[{"@type":"Product","name":"X","brand":"Radar","gtin12":"888645016697","mpn":"RX-1"}]</script>
</head><body>no gtin shown here</body></html>
```

- [ ] **Step 2: Write the failing test**
```python
# scripts/tests/test_structured_data.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from structured_data import extract_products
FIX = os.path.join(os.path.dirname(__file__), "fixtures", "jsonld_sample.html")

def test_extracts_products_with_gtin():
    prods = extract_products(open(FIX, encoding="utf-8").read())
    assert len(prods) == 2
    p = prods[0]
    assert p["brand"] == "Fortune" and p["gtin"] == "6970018810017"
    assert p["mpn"] == "FSR308-2657017" and "265/70R17" in p["name"]

def test_handles_brand_as_string_and_object():
    prods = extract_products(open(FIX, encoding="utf-8").read())
    assert prods[1]["brand"] == "Radar" and prods[1]["gtin"] == "888645016697"

def test_no_jsonld_returns_empty():
    assert extract_products("<html><body>nothing</body></html>") == []
```

- [ ] **Step 3: Run to verify fail** — `cd /c/Users/djsan/inventory/data/tire-knowledge && uv run python -m pytest scripts/tests/test_structured_data.py -v` → FAIL (module missing).

- [ ] **Step 4: Implement `scripts/structured_data.py`**
```python
import json, re

_LD = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                 re.S | re.I)
_GTIN_KEYS = ("gtin13", "gtin12", "gtin14", "gtin", "gtin8")

def _brand(v):
    if isinstance(v, dict):
        return str(v.get("name", "")).strip()
    return str(v or "").strip()

def _one(obj):
    if not isinstance(obj, dict):
        return None
    t = obj.get("@type", "")
    t = t if isinstance(t, str) else ",".join(t) if isinstance(t, list) else ""
    if "Product" not in t:
        return None
    gtin = ""
    for k in _GTIN_KEYS:
        if obj.get(k):
            gtin = str(obj[k]).strip(); break
    offers = obj.get("offers")
    oc = len(offers) if isinstance(offers, list) else (1 if offers else 0)
    return {"name": str(obj.get("name", "")).strip(),
            "brand": _brand(obj.get("brand")),
            "mpn": str(obj.get("mpn", "")).strip(),
            "sku": str(obj.get("sku", "")).strip(),
            "gtin": gtin, "offers_count": oc}

def _walk(node, out):
    if isinstance(node, dict):
        p = _one(node)
        if p:
            out.append(p)
        for v in node.values():
            _walk(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk(v, out)

def extract_products(html: str) -> list:
    out = []
    for block in _LD.findall(html or ""):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        _walk(data, out)
    # dedup by (gtin or name+mpn)
    seen, uniq = set(), []
    for p in out:
        key = p["gtin"] or (p["name"] + "|" + p["mpn"])
        if key and key not in seen:
            seen.add(key); uniq.append(p)
    return uniq
```

- [ ] **Step 5: Run to verify pass** — same pytest command → PASS (3 tests).
- [ ] **Step 6: Checkpoint** — note in `run-log.md`. No commit.

### Task 2: `phaseb_probe.py` — measure GTIN density per site (LIVE, ~10–15 credits)

**Files:** Create `scripts/phaseb_probe.py`.
**Interfaces:** Consumes `firecrawl_client.call`, `structured_data.extract_products`. Produces a printed table: per candidate `{site, url, products_found, gtins_found, est_rows_per_credit}` and writes `outputs/phaseb_probe_results.csv`.

- [ ] **Step 1:** Implement `phaseb_probe.py` with a `CANDIDATES` list of `(site, listing_url)` for SimpleTire, Tire Rack, TireBuyer, Discount Tire, Priority Tire, 1010tires (one dense listing URL each — fill real URLs at run time). For each: `firecrawl_client.call(["scrape","--format","rawHtml", url], expected_max_credits=2, run_state)`, run `extract_products`, count products with non-empty gtin. `est_rows_per_credit = gtins_found / max(1, credits_spent)`. Respect a total probe cap (~15) and the firewall.
- [ ] **Step 2 (LIVE probe):** Run `uv run python scripts/phaseb_probe.py`. Record results. **DECISION GATE:** any site with `est_rows_per_credit >= 8` → candidate for Milestone 2. If none → STOP bulk, report.
- [ ] **Step 3: Checkpoint** — append probe results table to `run-log.md`. No commit.

---

# MILESTONE 2 — Commit bulk source(s) (contingent on probe ≥8/credit)

*Expanded into full per-step TDD once Milestone 1 names the winning source(s). Shape:*

### Task 3: `harvest_structured.py` — generic structured-data harvester
**Files:** Create `scripts/harvest_structured.py`.
**Interfaces:** `harvest(site_config, max_credits, run_state, run_id)` where `site_config = {"name","enumerate":<sitemap|category-url-list>,"to_identity":<fn mapping a structured_data product -> pipeline identity>}`. Enumerate listing/product pages → `firecrawl_client.call` rawHtml → `structured_data.extract_products` → map to identity `{brand,model,mpn,retailer_sku,barcode(=gtin),size_canonical,size_compact,source_url,+enrichment}` → GTIN-validate → `write_outputs.write_rows` (dedup) → `audit_corpus`.
- [ ] Build the per-site `to_identity` mapper (parse model+size out of `name`, set barcode=gtin) + enumerator from probe findings.
- [ ] **ADAPTER GATE:** first live batch must show 0 bad GTINs, exact schema, 0 dup, AUDIT PASS, and **measured rows/credit ≥ 8** — else pull the source.
- [ ] Harvest with the bulk budget; re-run `verify_corpus_full.py` after.
- [ ] Checkpoint.

---

# MILESTONE 3 — Niche brands (hard cap 100 credits)

*Try in order; stop when satisfied or cap hit. Expanded to full detail when reached.*

### Task 4: `catalog_parse.py` (preferred)
- Find published Blackhawk/Fortune/Arisun EAN/UPC catalogs (PDF/Excel). `firecrawl_client.call(["parse", <file_or_url>...])` → rows → validate → write. Highest yield/credit if a catalog exists.

### Task 5: `barcode_api_lookup.py`
- Scrape SimpleTire listing pages (cheap, dense) for brand+MPN+model+size; resolve UPC via a barcode API (UPCitemDB/Go-UPC). **Validate coverage on a 10-item sample FIRST**; if hit-rate is poor, abandon. Firecrawl-cheap; API cost separate.

### Task 6: Amazon last-resort (only if 4 & 5 fail)
- Reuse `process_amazon.py` patterns; scrape Amazon product pages via `firecrawl_client` restricted to a curated **most-sold sizes** list (confirm list with owner). Hard-stop at the 100-credit niche cap.

---

## Self-Review

- **Spec coverage:** core insight/JSON-LD ✓ (Task 1). Probe + ≥8 gate ✓ (Task 2). Bulk commit + adapter gate ✓ (Task 3). Niche order catalogs→API→Amazon + 100 cap ✓ (Tasks 4–6). Pipeline reuse + firewall + untrusted-data ✓ (Global Constraints). Stop-if-none-clears-floor ✓ (Task 2 gate).
- **Placeholder scan:** Milestone 1 is fully coded. Milestones 2–3 are intentionally contingent on probe results (the spec's "empirical/open items") — they carry concrete interfaces + gates, and get per-step code once the source is known. The only deferred specifics (winning site's selectors, most-sold-sizes list) are genuinely data/owner-dependent, flagged explicitly.
- **Type consistency:** `extract_products` returns `gtin`/`mpn`/`brand`/`name`/`sku`/`offers_count`; Task 2 reads `gtin`; Task 3 maps `gtin`→barcode and reuses pipeline keys. Consistent.

## Open items (resolved during execution)
- Real listing URLs per candidate site (Task 2 run time).
- Winning source(s) ≥8/credit (Task 2 outcome) → drives Task 3.
- Barcode-API tire coverage (Task 5 sample).
- Most-sold-sizes list (Task 6, owner confirm).
