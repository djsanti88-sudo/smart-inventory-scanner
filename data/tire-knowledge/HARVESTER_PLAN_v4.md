# Tire Barcode Harvester v4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a credit-bulletproof local pipeline that harvests verified tire barcode rows from tiresandwheels.com (Phase A) using Firecrawl `map` + URL parsing, proving the whole pipeline for **zero credits** first.

**Architecture:** Pure-Python pipeline. Identity (`barcode, mpn, sku, brand, model, size`) is parsed from tiresandwheels.com URLs (free); GTIN + size validated locally; rows routed to trusted/backlog/rejected and written idempotently to schema-v3 CSVs. Every Firecrawl call goes through one metered wrapper enforcing a hard credit cap + kill switch. No local browser needed for Phase A (Firecrawl is cloud).

**Tech Stack:** Python 3.13 stdlib (`csv`, `json`, `re`, `subprocess`, `hashlib`, `datetime`), `pytest` (dev/test only), Firecrawl CLI v1.19.2 (already authenticated).

## Global Constraints

Copied verbatim from `HARVESTER_SPEC_v4.md`. Every task implicitly includes these.

- **Sandbox:** write ONLY inside `C:\Users\djsan\inventory\data\tire-knowledge`. Never touch app code or anything outside the sandbox.
- **Schema v3:** `tire_corpus_flat.csv` has exactly these 20 columns in order: `canonical_product_uid, brand, model, size_canonical, size_compact, load_index, speed_rating, tire_type, season, barcode, barcode_type, manufacturer_part_number, source_url, evidence_level, usable_for, current_status, missing_fields, field_completeness_score, harvested_at, run_id`. No `retailer_sku`, no `size_shop` in the flat file.
- **Trusted-row bar:** valid GTIN barcode AND (MPN or SKU) AND brand AND model AND `size_canonical` AND `size_compact`. Otherwise → backlog or rejected.
- **Never** invent/guess/repair a barcode or part number. **Never** keep invalid GTINs in trusted rows. **Never** parse barcodes as numbers; preserve leading zeros (store as strings). No row without a parseable size enters the corpus.
- **Credit caps:** `TOTAL_CAP=50`, `PER_RUN_CAP=15` Firecrawl credits, 110 in reserve. Kill switch file `.firecrawl_STOP` aborts before any spend. Escalation order: `map` → listing `scrape` → product `scrape` → stealth (off by default).
- **No paid API** beyond the Firecrawl carve-out (≤50 credits) and gated Gemini QA (`GEMINI_QA_ALLOWED=false` default).
- **Git:** do NOT commit/push/merge. Per owner doctrine, commits are owner-gated — each task ends with a **Checkpoint** (run proof), not a commit. Ask the owner before any `git commit`.
- **Dev dependency:** `pip install pytest` is required before running tests (local dev-only dep — confirm with owner at execution time).
- **Verification:** tiresandwheels rows = `verified_1src_strong` (URL-encoded UPC + passing GTIN check). No credits spent purely on verification.

---

## File Structure

```
tire-knowledge/
├── scripts/
│   ├── validate.py                  (MODIFY) source of truth: GTIN, size, UID, scoring, trusted-bar
│   ├── parse_tiresandwheels_url.py  (CREATE) zero-credit URL → identity
│   ├── ledger.py                    (CREATE) load/update/check coverage_ledger.json
│   ├── write_outputs.py            (CREATE) routing + idempotent CSV writers
│   ├── seed_from_example.py        (CREATE) Gate 0: import 95 example rows free
│   ├── firecrawl_client.py         (CREATE) metered Firecrawl wrapper (cap, kill switch, log)
│   ├── collect_sources.py          (CREATE) map → URL queue
│   ├── harvest_tiresandwheels.py   (CREATE) queue → parse → validate → route → write
│   ├── enrich_listings.py          (CREATE) metered listing scrape → fill load/speed/season
│   ├── audit_corpus.py             (CREATE) schema/dup/GTIN/size/ledger audit
│   ├── run_once.py                 (CREATE) preflight + orchestrator
│   ├── scheduler.py                (CREATE, INERT) disabled scheduler
│   ├── setup_local_task.py         (CREATE, INERT) Task Scheduler helper
│   └── tests/
│       ├── test_validate.py        (CREATE)
│       ├── test_parse_url.py       (CREATE)
│       ├── test_write_outputs.py   (CREATE)
│       ├── test_firecrawl_client.py(CREATE)
│       └── fixtures/tire_c_1.csv   (CREATE) copy of the 95-row example
├── firecrawl_policy.json           (CREATE) caps + kill switch config
├── seed/TIRE_C_1.csv               (CREATE) copy of example for seeding
└── RECONCILIATION.md               (CREATE) doctrine conflict record
```

---

# MILESTONE 1 — Free core pipeline (reaches Gate 0, zero credits)

Tasks 1–6. Deliverable: seed the 95 example rows through validate → route → write → ledger → audit, idempotently, spending **0 credits**.

---

### Task 1: Harden `validate.py` (trusted-bar + schema-aligned labels + regression fixture)

**Files:**
- Modify: `scripts/validate.py`
- Create: `scripts/tests/test_validate.py`
- Create: `scripts/tests/fixtures/tire_c_1.csv` (copy the 95-row example verbatim)

**Interfaces:**
- Consumes: existing `gtin_check_digit_valid`, `normalize_size`, `normalize_brand`, `normalize_model`, `make_uid`, `now_iso`, `FLAT_COLS`.
- Produces:
  - `barcode_type_label(barcode: str) -> str` returning one of `upc|ean|gtin14|ean8|unknown` (rename len-14 result from `gtin` to `gtin14`).
  - `is_trusted_identity(row: dict) -> tuple[bool, str]` → `(True, "")` if trusted-bar met, else `(False, reason)`.

- [ ] **Step 1: Copy the example fixture**

Copy `C:\Users\djsan\Downloads\TIRE_C_1 (1).CSV` to `scripts/tests/fixtures/tire_c_1.csv` and to `seed/TIRE_C_1.csv` (exact bytes, preserve leading zeros — copy as a file, do not re-serialize).

- [ ] **Step 2: Write the failing test**

```python
# scripts/tests/test_validate.py
import csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import validate as v

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "tire_c_1.csv")

def test_barcode_type_label_aligned():
    assert v.barcode_type_label("848983006257") == "upc"     # 12
    assert v.barcode_type_label("4981910544517") == "ean"    # 13
    assert v.barcode_type_label("00012345678905") == "gtin14" # 14

def test_trusted_identity_accepts_full_row():
    row = {"barcode": "848983006257", "manufacturer_part_number": "28034300",
           "brand": "Falken", "model": "Wildpeak A/T3W",
           "size_canonical": "265/70R17", "size_compact": "2657017"}
    ok, reason = v.is_trusted_identity(row)
    assert ok is True and reason == ""

def test_trusted_identity_rejects_missing_mpn_and_sku():
    row = {"barcode": "848983006257", "manufacturer_part_number": "",
           "retailer_sku": "", "brand": "Falken", "model": "X",
           "size_canonical": "265/70R17", "size_compact": "2657017"}
    ok, reason = v.is_trusted_identity(row)
    assert ok is False and "mpn" in reason.lower()

def test_trusted_identity_rejects_bad_gtin():
    row = {"barcode": "848983006250", "manufacturer_part_number": "28034300",
           "brand": "Falken", "model": "X",
           "size_canonical": "265/70R17", "size_compact": "2657017"}
    ok, reason = v.is_trusted_identity(row)
    assert ok is False and "gtin" in reason.lower()

def test_every_fixture_barcode_is_valid_gtin():
    with open(FIX, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) >= 90
    bad = [r["barcode"] for r in rows if not v.gtin_check_digit_valid(r["barcode"])]
    assert bad == [], f"invalid GTINs in fixture: {bad}"

def test_every_fixture_size_normalizes():
    with open(FIX, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        c, k = v.normalize_size(r["size_canonical"])
        assert c is not None, f"size failed: {r['size_canonical']}"
        assert k == r["size_compact"], f"{r['size_canonical']} -> {k} != {r['size_compact']}"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd C:\Users\djsan\inventory\data\tire-knowledge && python -m pytest scripts/tests/test_validate.py -v`
Expected: FAIL — `barcode_type_label` returns `gtin` not `gtin14`; `is_trusted_identity` not defined.

- [ ] **Step 4: Implement the minimal changes in `validate.py`**

In `barcode_type_label`, change the len-14 branch from `return "gtin"` to `return "gtin14"`. Then append:

```python
def is_trusted_identity(row: dict):
    """Trusted bar: valid GTIN + (MPN or SKU) + brand + model + size_canonical + size_compact."""
    bc = str(row.get("barcode", "")).strip()
    if not gtin_check_digit_valid(bc):
        return False, "barcode missing or fails GTIN check"
    mpn = str(row.get("manufacturer_part_number", "")).strip()
    sku = str(row.get("retailer_sku", "")).strip()
    if not (mpn or sku):
        return False, "missing both MPN and SKU"
    for fld in ("brand", "model", "size_canonical", "size_compact"):
        if not str(row.get(fld, "")).strip():
            return False, f"missing {fld}"
    return True, ""
```

- [ ] **Step 5: Run tests + existing self-test**

Run: `python -m pytest scripts/tests/test_validate.py -v` → Expected: PASS (6 tests).
Run: `python scripts/validate.py` → Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Checkpoint** — both green. Do NOT commit (owner-gated). Note completion in `run-log.md`.

---

### Task 2: `parse_tiresandwheels_url.py` (zero-credit URL → identity)

**Files:**
- Create: `scripts/parse_tiresandwheels_url.py`
- Create: `scripts/tests/test_parse_url.py`

**Interfaces:**
- Consumes: `validate.normalize_size`.
- Produces: `parse_url(url: str) -> dict | None` returning `{brand, model, mpn, retailer_sku, barcode, size_canonical, size_compact, source_url}` or `None` if the URL is not a parseable tiresandwheels product URL.

URL shape (two observed tail variants — `/` and `_` separators):
```
.../product/tire/{EC_SKU}/{Brand}/{MPN}/{Model}_{BARCODE}_{SIZE}
.../product/tire/{EC_SKU}/{Brand}/{MPN}_{Model}_{BARCODE}_{SIZE}
```
`{SIZE}` uses `+` for `/` (e.g. `265+70R17`, `LT275+65R18`).

- [ ] **Step 1: Write the failing test**

```python
# scripts/tests/test_parse_url.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from parse_tiresandwheels_url import parse_url

def test_slash_variant():
    u = "https://www.tiresandwheels.com/product/tire/EC106252/Falken/28034300/Wildpeak-A/T3W_848983006257_265+70R17"
    r = parse_url(u)
    assert r["brand"] == "Falken"
    assert r["mpn"] == "28034300"
    assert r["retailer_sku"] == "EC106252"
    assert r["barcode"] == "848983006257"
    assert r["size_canonical"] == "265/70R17"
    assert r["size_compact"] == "2657017"

def test_underscore_variant_lt_size():
    u = "https://www.tiresandwheels.com/product/tire/EC106243/Falken/28030803_Wildpeak+A/T3W_848983006479_LT275+65R18"
    r = parse_url(u)
    assert r["mpn"] == "28030803"
    assert r["barcode"] == "848983006479"
    assert r["size_canonical"] == "LT275/65R18"
    assert r["size_compact"] == "2756518"

def test_ean_13_barcode():
    u = "https://www.tiresandwheels.com/product/tire/EC419232/Nitto/218730/Recon-Grappler-A/T_4981910544517_LT275+70R18"
    r = parse_url(u)
    assert r["barcode"] == "4981910544517"
    assert r["size_canonical"] == "LT275/70R18"

def test_non_product_url_returns_none():
    assert parse_url("https://www.tiresandwheels.com/brands/falken") is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest scripts/tests/test_parse_url.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parse_tiresandwheels_url.py`**

```python
import re
from urllib.parse import urlparse, unquote
from validate import normalize_size

# barcode = 12-14 digit run; size tail = digits/letters with + for slashes, R for rim
_TAIL = re.compile(r"_(\d{12,14})_([A-Za-z0-9+.]+)$")
_BARCODE = re.compile(r"^\d{12,14}$")

def _size_from_tail(raw: str) -> str:
    # "265+70R17" -> "265/70R17" ; "LT275+65R18" -> "LT275/65R18"
    return raw.replace("+", "/")

def parse_url(url: str):
    p = urlparse(url)
    if "tiresandwheels.com" not in p.netloc:
        return None
    path = unquote(p.path)
    if "/product/tire/" not in path:
        return None
    segs = [s for s in path.split("/") if s]
    # expected: product, tire, {SKU}, {Brand}, {MPN...tail}
    try:
        i = segs.index("tire")
    except ValueError:
        return None
    rest = segs[i + 1:]
    if len(rest) < 3:
        return None
    sku, brand = rest[0], rest[1]
    tail = "/".join(rest[2:])  # rejoin model paths that contained '/'
    m = _TAIL.search(tail)
    if not m:
        return None
    barcode, size_raw = m.group(1), m.group(2)
    if not _BARCODE.match(barcode):
        return None
    head = tail[:m.start()]  # "{MPN}/{Model}" or "{MPN}_{Model}"
    if "/" in head:
        mpn, model = head.split("/", 1)
    elif "_" in head:
        mpn, model = head.split("_", 1)
    else:
        mpn, model = head, ""
    model = model.replace("+", " ").replace("-", " ").replace("_", " ").strip()
    size_canonical, size_compact = normalize_size(_size_from_tail(size_raw))
    if not size_canonical:
        return None
    return {
        "brand": brand.replace("-", " ").strip(),
        "model": model,
        "mpn": mpn.strip(),
        "retailer_sku": sku.strip(),
        "barcode": barcode,
        "size_canonical": size_canonical,
        "size_compact": size_compact,
        "source_url": url,
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest scripts/tests/test_parse_url.py -v` → Expected: PASS (4 tests).

- [ ] **Step 5: Validate against the full fixture**

Run this one-off check: parse the `source_url` of every fixture row and assert the parsed `barcode` and `size_compact` equal the fixture's columns.
```bash
python -c "import csv,sys; sys.path.insert(0,'scripts'); from parse_tiresandwheels_url import parse_url; rows=list(csv.DictReader(open('scripts/tests/fixtures/tire_c_1.csv',encoding='utf-8'))); bad=[r['source_url'] for r in rows if (parse_url(r['source_url']) or {}).get('barcode')!=r['barcode']]; print('MISMATCHES',len(bad)); [print(b) for b in bad[:5]]"
```
Expected: `MISMATCHES 0`. If any mismatch, fix the parser regex (do not edit the fixture).

- [ ] **Step 6: Checkpoint** — green. Log to `run-log.md`. No commit.

---

### Task 3: `ledger.py` (coverage ledger load/update/consistency)

**Files:**
- Create: `scripts/ledger.py`
- Test: covered via `test_write_outputs.py` in Task 4 (ledger is exercised through writes).

**Interfaces:**
- Produces:
  - `load_ledger(path) -> dict`
  - `seen_barcode(ledger, bc) -> bool`
  - `record_row(ledger, row) -> None` (adds barcode, identity key, source_url to seen sets; bumps counts)
  - `save_ledger(ledger, path) -> None`
  - `counts_match_csv(ledger, flat_csv_path) -> tuple[bool,str]`

- [ ] **Step 1: Implement `ledger.py`**

```python
import json, csv, os
import validate as v

def load_ledger(path):
    if not os.path.exists(path):
        return {"schema_version":"3.0","total_trusted_barcode_rows":0,
                "total_backlog_rows":0,"total_rejected_rows":0,
                "checkpoint_last":0,"checkpoint_next":5000,
                "seen_barcodes":[],"seen_part_numbers":[],"seen_identity_keys":[],
                "seen_source_urls":[],"search_queries_done":[],"cells_done":[],
                "bad_sources":[],"blocked_sources":[],"runs":[]}
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def seen_barcode(ledger, bc):
    return bc in set(ledger["seen_barcodes"])

def record_row(ledger, row):
    bc = row["barcode"]
    if bc not in ledger["seen_barcodes"]:
        ledger["seen_barcodes"].append(bc)
        ledger["total_trusted_barcode_rows"] += 1
    key = v.make_identity_key(row["brand"], row["model"], row["size_canonical"],
                              row.get("load_index",""), row.get("speed_rating",""),
                              row.get("manufacturer_part_number",""))
    if key not in ledger["seen_identity_keys"]:
        ledger["seen_identity_keys"].append(key)
    if row.get("manufacturer_part_number") and row["manufacturer_part_number"] not in ledger["seen_part_numbers"]:
        ledger["seen_part_numbers"].append(row["manufacturer_part_number"])
    if row["source_url"] not in ledger["seen_source_urls"]:
        ledger["seen_source_urls"].append(row["source_url"])

def save_ledger(ledger, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2)

def counts_match_csv(ledger, flat_csv_path):
    with open(flat_csv_path, newline="", encoding="utf-8") as f:
        n = sum(1 for _ in csv.DictReader(f))
    if n != ledger["total_trusted_barcode_rows"]:
        return False, f"ledger {ledger['total_trusted_barcode_rows']} != csv {n}"
    return True, ""
```

- [ ] **Step 2: Checkpoint** — exercised in Task 4. No standalone run needed.

---

### Task 4: `write_outputs.py` (routing + idempotent writers)

**Files:**
- Create: `scripts/write_outputs.py`
- Create: `scripts/tests/test_write_outputs.py`

**Interfaces:**
- Consumes: `validate` (`is_trusted_identity`, `barcode_type_label`, `make_uid`, `completeness_score`, `missing_fields_str`, `now_iso`, `FLAT_COLS`), `ledger`.
- Produces:
  - `build_flat_row(identity: dict, run_id: str) -> dict` (fills schema-v3 fields; `evidence_level="verified_1src_strong"`, `usable_for="auto_count_candidate"`, `current_status="active_retail"`).
  - `route(identity: dict) -> str` → `"trusted" | "backlog" | "rejected"`.
  - `write_rows(identities: list[dict], paths: dict, ledger: dict, run_id: str) -> dict` returns counts `{trusted, backlog, rejected, dup_skipped}`; appends trusted→flat, sku→identifiers, size→size_aliases; dedups by `seen_barcode`; flushes per row.

- [ ] **Step 1: Write the failing test**

```python
# scripts/tests/test_write_outputs.py
import os, sys, csv, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import write_outputs as w, ledger as L, validate as v

GOOD = {"brand":"Falken","model":"Wildpeak A/T3W","mpn":"28034300","retailer_sku":"EC106252",
        "barcode":"848983006257","size_canonical":"265/70R17","size_compact":"2657017",
        "manufacturer_part_number":"28034300",
        "source_url":"https://www.tiresandwheels.com/x"}

def _paths(d):
    flat=os.path.join(d,"flat.csv"); 
    with open(flat,"w",newline="",encoding="utf-8") as f:
        csv.writer(f).writerow(v.FLAT_COLS)
    ids=os.path.join(d,"ids.csv"); open(ids,"w",encoding="utf-8").write("barcode,retailer_sku,source_url\n")
    return {"flat":flat,"identifiers":ids,"size_aliases":os.path.join(d,"sz.csv")}

def test_route():
    assert w.route(GOOD) == "trusted"
    assert w.route({**GOOD,"manufacturer_part_number":"","retailer_sku":""}) == "backlog"
    assert w.route({**GOOD,"barcode":"848983006250"}) == "rejected"

def test_write_is_idempotent():
    with tempfile.TemporaryDirectory() as d:
        paths=_paths(d); led=L.load_ledger(os.path.join(d,"ledger.json"))
        c1=w.write_rows([GOOD],paths,led,"run_x")
        c2=w.write_rows([GOOD],paths,led,"run_x")
        assert c1["trusted"]==1 and c2["dup_skipped"]==1
        with open(paths["flat"],newline="",encoding="utf-8") as f:
            assert sum(1 for _ in csv.DictReader(f))==1
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m pytest scripts/tests/test_write_outputs.py -v` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `write_outputs.py`**

```python
import csv, os
import validate as v
import ledger as L

def route(identity):
    ok, reason = v.is_trusted_identity({**identity,
        "manufacturer_part_number": identity.get("manufacturer_part_number") or identity.get("mpn","")})
    if ok:
        return "trusted"
    if "gtin" in reason.lower() or "size" in reason.lower():
        return "rejected"
    return "backlog"

def build_flat_row(identity, run_id):
    mpn = identity.get("manufacturer_part_number") or identity.get("mpn","")
    row = {
        "brand": v.normalize_brand(identity["brand"]),
        "model": v.normalize_model(identity["model"]),
        "size_canonical": identity["size_canonical"],
        "size_compact": identity["size_compact"],
        "load_index": identity.get("load_index",""),
        "speed_rating": identity.get("speed_rating",""),
        "tire_type": identity.get("tire_type",""),
        "season": identity.get("season",""),
        "barcode": identity["barcode"],
        "barcode_type": v.barcode_type_label(identity["barcode"]),
        "manufacturer_part_number": mpn,
        "source_url": identity["source_url"],
        "evidence_level": "verified_1src_strong",
        "usable_for": "auto_count_candidate",
        "current_status": "active_retail",
    }
    row["canonical_product_uid"] = v.make_uid(row["brand"], row["model"],
        row["size_canonical"], row["load_index"], row["speed_rating"], mpn)
    row["missing_fields"] = v.missing_fields_str(row)
    row["field_completeness_score"] = int(round(v.completeness_score(row)*100))
    row["harvested_at"] = v.now_iso()
    row["run_id"] = run_id
    return row

def _append(path, header, rowdict):
    new = not os.path.exists(path)
    with open(path,"a",newline="",encoding="utf-8") as f:
        wtr=csv.DictWriter(f, fieldnames=header)
        if new: wtr.writeheader()
        wtr.writerow({k:rowdict.get(k,"") for k in header}); f.flush()

def write_rows(identities, paths, led, run_id):
    counts={"trusted":0,"backlog":0,"rejected":0,"dup_skipped":0}
    for idn in identities:
        dest=route(idn)
        if dest!="trusted":
            counts[dest]+=1; continue
        if L.seen_barcode(led, idn["barcode"]):
            counts["dup_skipped"]+=1; continue
        flat=build_flat_row(idn, run_id)
        with open(paths["flat"],"a",newline="",encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=v.FLAT_COLS).writerow(flat); f.flush()
        if idn.get("retailer_sku"):
            _append(paths["identifiers"],["barcode","retailer_sku","source_url"],
                    {"barcode":idn["barcode"],"retailer_sku":idn["retailer_sku"],"source_url":idn["source_url"]})
        L.record_row(led, flat)
        counts["trusted"]+=1
    return counts
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest scripts/tests/test_write_outputs.py -v` → Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint** — green. Log to `run-log.md`. No commit.

---

### Task 5: `audit_corpus.py` (schema/dup/GTIN/size/ledger audit)

**Files:**
- Create: `scripts/audit_corpus.py`

**Interfaces:**
- Produces: `audit(root: str) -> tuple[bool, list[str]]` — checks: flat header == `FLAT_COLS` exactly; no duplicate `barcode`; no duplicate `canonical_product_uid`; every `barcode` passes GTIN; every row has `size_canonical`+`size_compact`; `ledger.counts_match_csv`. CLI prints report and exits non-zero on failure.

- [ ] **Step 1: Implement `audit_corpus.py`**

```python
import csv, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import validate as v, ledger as L

def audit(root):
    errs=[]
    flat=os.path.join(root,"tire_corpus_flat.csv")
    with open(flat,newline="",encoding="utf-8") as f:
        rdr=csv.reader(f); header=next(rdr,[])
        if header!=v.FLAT_COLS: errs.append(f"schema header mismatch: {header}")
    with open(flat,newline="",encoding="utf-8") as f:
        rows=list(csv.DictReader(f))
    seen_bc=set(); seen_uid=set()
    for r in rows:
        bc=r["barcode"]
        if bc in seen_bc: errs.append(f"dup barcode {bc}")
        seen_bc.add(bc)
        if r["canonical_product_uid"] in seen_uid: errs.append(f"dup uid {r['canonical_product_uid']}")
        seen_uid.add(r["canonical_product_uid"])
        if not v.gtin_check_digit_valid(bc): errs.append(f"bad GTIN {bc}")
        if not r["size_canonical"] or not r["size_compact"]: errs.append(f"missing size {bc}")
    led=L.load_ledger(os.path.join(root,"coverage_ledger.json"))
    ok,msg=L.counts_match_csv(led, flat)
    if not ok: errs.append(msg)
    return (len(errs)==0, errs)

if __name__=="__main__":
    root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ok,errs=audit(root)
    print("AUDIT PASS" if ok else "AUDIT FAIL")
    for e in errs: print("  -",e)
    sys.exit(0 if ok else 1)
```

- [ ] **Step 2: Checkpoint** — exercised by Task 6 (run against seeded corpus). No commit.

---

### Task 6: `seed_from_example.py` — **Gate 0 (free, zero credits)**

**Files:**
- Create: `scripts/seed_from_example.py`

**Interfaces:**
- Consumes: `parse_tiresandwheels_url.parse_url`, `write_outputs.write_rows`, `ledger`, `audit_corpus.audit`.
- Produces: CLI that reads `seed/TIRE_C_1.csv`, re-derives identity from each row's `source_url` (URL is source of truth), merges the row's existing load/speed/type/season, routes/writes, updates ledger, runs audit.

- [ ] **Step 1: Implement `seed_from_example.py`**

```python
import csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_tiresandwheels_url import parse_url
import write_outputs as w, ledger as L, audit_corpus

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED=os.path.join(ROOT,"seed","TIRE_C_1.csv")

def main():
    with open(SEED,newline="",encoding="utf-8") as f:
        src=list(csv.DictReader(f))
    identities=[]
    for r in src:
        idn=parse_url(r["source_url"])
        if not idn:
            continue
        # URL is source of truth for identity; carry enrichment fields from the seed row
        for fld in ("load_index","speed_rating","tire_type","season"):
            idn[fld]=r.get(fld,"")
        idn["manufacturer_part_number"]=idn["mpn"]
        identities.append(idn)
    led=L.load_ledger(os.path.join(ROOT,"coverage_ledger.json"))
    paths={"flat":os.path.join(ROOT,"tire_corpus_flat.csv"),
           "identifiers":os.path.join(ROOT,"tire_identifiers.csv"),
           "size_aliases":os.path.join(ROOT,"tire_size_aliases.csv")}
    counts=w.write_rows(identities, paths, led, "seed_example_001")
    L.save_ledger(led, os.path.join(ROOT,"coverage_ledger.json"))
    print("SEED COUNTS", counts)
    ok,errs=audit_corpus.audit(ROOT)
    print("AUDIT PASS" if ok else "AUDIT FAIL"); [print("  -",e) for e in errs]
    sys.exit(0 if ok else 1)

if __name__=="__main__":
    main()
```

- [ ] **Step 2: Reset corpus to a clean header-only state**

Confirm `tire_corpus_flat.csv` has only the header row (it currently does). Ensure no stale `harvest.lock` blocks (delete if present; current one is stale from run_001).

- [ ] **Step 3: Run the seed (Gate 0)**

Run: `python scripts/seed_from_example.py`
Expected: `SEED COUNTS {'trusted': ~95, 'backlog': 0, 'rejected': 0, 'dup_skipped': 0}` then `AUDIT PASS`.

- [ ] **Step 4: Prove idempotency**

Run the same command twice more. Expected: 2nd/3rd runs show `dup_skipped: ~95`, `trusted: 0`; `AUDIT PASS`; flat CSV still has exactly ~95 data rows.
```bash
python -c "import csv; print('rows', sum(1 for _ in csv.DictReader(open('tire_corpus_flat.csv',encoding='utf-8'))))"
```

- [ ] **Step 5: Checkpoint — GATE 0 COMPLETE (0 credits).** Append a Gate 0 result block to `run-log.md`: row count, audit result, idempotency proof. No commit unless owner asks.

---

# MILESTONE 2 — Firecrawl harvesting (Gates 1–4, ≤50 credits)

Tasks 7–11. Deliverable: live tiresandwheels harvest through the credit firewall, with measured rows-per-credit.

### Task 7: `firecrawl_policy.json` + `firecrawl_client.py` (credit firewall)
**Files:** Create `firecrawl_policy.json`, `scripts/firecrawl_client.py`, `scripts/tests/test_firecrawl_client.py`.
**Interfaces:** Produces `get_credits() -> int` (parses `firecrawl --status`); `kill_switch_active() -> bool`; `call(cmd_args: list, expected_max_credits: int, run_state: dict) -> dict` (aborts if kill switch present, if `PER_RUN_CAP`/`TOTAL_CAP` would be exceeded, or credits unreadable; measures credits before/after; records spend into `run_state`).
- [ ] **Step 1:** Write `firecrawl_policy.json`: `{"TOTAL_CAP":50,"PER_RUN_CAP":15,"ROWS_PER_CREDIT_FLOOR":null,"STEALTH_ALLOWED":false,"KILL_SWITCH_FILE":".firecrawl_STOP"}`.
- [ ] **Step 2:** Write failing tests mocking `subprocess.run`: (a) kill-switch file present → `call` raises `RuntimeError` before any subprocess call; (b) requested credits would exceed `PER_RUN_CAP` → raises; (c) normal call records `credits_spent = before-after`.
- [ ] **Step 3:** Run tests → FAIL.
- [ ] **Step 4:** Implement `firecrawl_client.py` (subprocess to `firecrawl`; regex-parse the `Credits: N / M` line from `--status`; enforce caps + kill switch; never call when `get_credits()` fails).
- [ ] **Step 5:** Run tests → PASS.
- [ ] **Step 6: Checkpoint.** No commit.

### Task 8: `collect_sources.py` (map → URL queue) — **Gate 2**
**Files:** Create `scripts/collect_sources.py` (writes `tire_sources.csv` queue of candidate product URLs).
**Interfaces:** Consumes `firecrawl_client.call`. Produces `collect(run_state) -> int` (runs `firecrawl map` on tiresandwheels tire paths, filters to `/product/tire/` URLs, dedups vs `ledger.seen_source_urls`, appends to queue).
- [ ] **Step 1:** Preflight check `robots.txt`/ToS for the catalog paths; record in `run-log.md`. If disallowed, STOP and flag to owner.
- [ ] **Step 2:** Implement `collect` using one `map` call (≤2 credits) via `firecrawl_client`.
- [ ] **Step 3 (Gate 2):** Run once; log URLs returned + credits spent; assert queue non-empty and all queued URLs `parse_url`-able.
- [ ] **Step 4: Checkpoint.** No commit.

### Task 9: `harvest_tiresandwheels.py` (queue → parse → validate → route → write) — **Gate 3**
**Files:** Create `scripts/harvest_tiresandwheels.py`.
**Interfaces:** Consumes `parse_url`, `write_outputs.write_rows`, `ledger`, `audit_corpus`. Produces `harvest(limit, run_state) -> dict` (pops queue, parses URLs — **free, no scrape** — routes/writes, updates ledger, audits).
- [ ] **Step 1:** Implement harvest loop (URL-parse only; zero scrape credits for identity).
- [ ] **Step 2 (Gate 3):** Run to ≥50 trusted rows; rerun twice → 0 dup; `audit_corpus` PASS; compute and log **rows-per-credit**; set `ROWS_PER_CREDIT_FLOOR` in policy to a conservative fraction of measured value.
- [ ] **Step 3: Checkpoint.** No commit.

### Task 10: `enrich_listings.py` (metered listing scrape → load/speed/season) — **Gate 4**
**Files:** Create `scripts/enrich_listings.py`.
**Interfaces:** Consumes `firecrawl_client.call` (listing-page `scrape --format markdown`), `validate`. Produces `enrich(sample_n, run_state) -> dict` (scrapes a few listing/category pages within `PER_RUN_CAP`, parses load/speed/season, updates matching flat rows, bumps completeness; never overrides barcode/identity).
- [ ] **Step 1:** Implement enrich with strict per-run credit guard + efficiency abort.
- [ ] **Step 2 (Gate 4):** Run a small sample; assert backlog/identity rows gain load/speed/season and completeness rises ~70→~90; log credits + rows-per-credit.
- [ ] **Step 3: Checkpoint.** No commit.

### Task 11: `run_once.py` (preflight + orchestrator) — **Gate 1**
**Files:** Create `scripts/run_once.py`.
**Interfaces:** Orchestrates: preflight (paths writable, `firecrawl --status` readable, policy loads, kill switch verified, stale lock reclaimed) → `collect` (if queue low) → `harvest` → optional `enrich` → `audit` → write `run-log.md` + `current_run_progress.json` → release lock. Honors `PER_RUN_CAP`/`TOTAL_CAP` across the whole run.
- [ ] **Step 1:** Implement preflight (Gate 1) + orchestration + lock discipline (>90 min stale reclaim) + per-run credit accounting.
- [ ] **Step 2 (Gate 1):** Run `python scripts/run_once.py --preflight-only`; expected all checks pass, 0 credits spent.
- [ ] **Step 3:** Full attended run within `PER_RUN_CAP`; `audit` PASS; run-log records credits + rows-per-credit.
- [ ] **Step 4: Checkpoint.** No commit.

---

# MILESTONE 3 — Deferred infra (built, inert)

Tasks 12–13. Deliverable: scheduler + Gemini QA gate exist but stay off until owner enables.

### Task 12: `scheduler.py` + `setup_local_task.py` (INERT)
**Files:** Create both.
**Interfaces:** `scheduler.py` reads an `ENABLED=false` guard and refuses to run unless explicitly set; `setup_local_task.py` prints (does not execute) the Task Scheduler registration command.
- [ ] **Step 1:** Implement with hard `ENABLED=false` default; running while disabled prints a refusal and exits 0.
- [ ] **Step 2:** Test: invoking `scheduler.py` with default config does NOT call `run_once`.
- [ ] **Step 3: Checkpoint.** No commit.

### Task 13: Gemini QA gate stub + config + dirs (DEFERRED)
**Files:** Create `scripts/gemini_qa_batch.py` (gate only), `outputs/gemini_qa/.gitkeep`; add `GEMINI_QA_ALLOWED=false`, `GEMINI_QA_BUDGET_CAP` to a local config.
**Interfaces:** `gemini_qa_batch.py` checks `GEMINI_QA_ALLOWED` + key presence + budget; if not all true, prints `AI_QA_SKIPPED=true` and exits 0 (no provider call, no implementation of QA logic yet).
- [ ] **Step 1:** Implement the gate only (no live calls). 
- [ ] **Step 2:** Test: with `GEMINI_QA_ALLOWED=false`, running prints `AI_QA_SKIPPED=true` and makes no network call.
- [ ] **Step 3: Checkpoint.** No commit.

### Task 14: `RECONCILIATION.md` + run-log discipline
**Files:** Create `RECONCILIATION.md` (record the Firecrawl carve-out overriding the 3 no-paid-API bans, scoped to 50 credits; tiresandwheels=Tier1, Amazon=Phase B); ensure every gate appended a result block to `run-log.md`.
- [ ] **Step 1:** Write `RECONCILIATION.md` per the spec's section 11.
- [ ] **Step 2: Checkpoint** — final: re-run `audit_corpus.py`, confirm PASS, confirm total credits spent ≤ caps. No commit unless owner asks.

---

## Self-Review

- **Spec coverage:** Strategy phases ✓ (M1/M2 Phase A, Phase B noted out-of-scope). Quality bar ✓ (`is_trusted_identity`, Task 1/4). Credit firewall ✓ (Task 7). URL goldmine ✓ (Task 2). Free seed/Gate 0 ✓ (Task 6). Verification `verified_1src_strong` ✓ (Task 4 `build_flat_row`). Automation disabled ✓ (Task 12). Gemini deferred+wired ✓ (Task 13). Reconciliation ✓ (Task 14). Proof gates 0–4 ✓ mapped to tasks. Schema v3 ✓ (`FLAT_COLS`, audit Task 5).
- **Placeholder scan:** No "TODO/TBD" except `ROWS_PER_CREDIT_FLOOR=null`, intentionally set empirically in Task 9 (documented in spec §13).
- **Type consistency:** `is_trusted_identity` reads `manufacturer_part_number` (Task 4 maps `mpn`→it before routing); `parse_url` returns `mpn`+`retailer_sku`; `build_flat_row` + `record_row` both use `manufacturer_part_number`. `FLAT_COLS` from `validate` used by writer + audit. Consistent.

---

## Open items
- `ROWS_PER_CREDIT_FLOOR` — set in Task 9 from measured value.
- Confirm tiresandwheels `robots.txt` allows catalog paths — Task 8 Step 1 (hard stop if not).
- Milestones 2–3 tasks are at step-summary granularity; expand each into full per-step TDD detail at execution time if using subagent-driven development.
