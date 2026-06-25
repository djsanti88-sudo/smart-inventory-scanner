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
    assert w.route({**GOOD,"manufacturer_part_number":"","mpn":"","retailer_sku":""}) == "backlog"
    assert w.route({**GOOD,"barcode":"848983006250"}) == "rejected"

def test_write_is_idempotent():
    with tempfile.TemporaryDirectory() as d:
        paths=_paths(d); led=L.load_ledger(os.path.join(d,"ledger.json"))
        c1=w.write_rows([GOOD],paths,led,"run_x")
        c2=w.write_rows([GOOD],paths,led,"run_x")
        assert c1["trusted"]==1 and c2["dup_skipped"]==1
        with open(paths["flat"],newline="",encoding="utf-8") as f:
            assert sum(1 for _ in csv.DictReader(f))==1

def test_route_parse_url_style_with_sku_is_trusted():
    idn={"brand":"Falken","model":"X","mpn":"28034300","retailer_sku":"EC1",
         "barcode":"848983006257","size_canonical":"265/70R17","size_compact":"2657017","source_url":"u"}
    assert w.route(idn) == "trusted"

def test_route_mpn_only_is_trusted_after_merge():
    idn={"brand":"Falken","model":"X","mpn":"28034300","retailer_sku":"",
         "barcode":"848983006257","size_canonical":"265/70R17","size_compact":"2657017","source_url":"u"}
    assert w.route(idn) == "trusted"

def test_verified_db_row_is_trusted_without_mpn_or_sku():
    with tempfile.TemporaryDirectory() as d:
        paths=_paths(d); led=L.load_ledger(os.path.join(d,"ledger.json"))
        idn={"brand":"Fortune","model":"Tormenta A/T FSR308","mpn":"","retailer_sku":"",
             "barcode":"840139631771","size_canonical":"245/70R17","size_compact":"2457017",
             "evidence_level":"verified_db","source_url":"u"}
        # 840139631771 passes GTIN check (verified above)
        assert w.route(idn) == "trusted"
        c=w.write_rows([idn],paths,led,"run_db")
        assert c["trusted"]==1
        import csv as _csv
        row=next(_csv.DictReader(open(paths["flat"],encoding="utf-8")))
        assert row["evidence_level"]=="verified_db"

def test_non_db_row_still_needs_mpn_or_sku():
    idn={"brand":"X","model":"Y","mpn":"","retailer_sku":"","barcode":"848983006257",
         "size_canonical":"265/70R17","size_compact":"2657017","source_url":"u"}
    assert w.route(idn) == "backlog"  # no evidence_level => strict bar => backlog (no mpn/sku)

def test_verified_db_two_barcodes_same_model_get_different_uids_and_clean_mpn():
    """Two verified_db rows with same brand/model/size but different barcodes must:
    - both be written as trusted
    - get DIFFERENT canonical_product_uid (uid uniqueness from barcode, not mpn)
    - both have manufacturer_part_number == "" when no model code is given
    """
    with tempfile.TemporaryDirectory() as d:
        paths = _paths(d)
        led = L.load_ledger(os.path.join(d, "ledger.json"))
        base = {
            "brand": "Fortune", "model": "Tormenta A/T", "mpn": "",
            "retailer_sku": "", "size_canonical": "245/70R17", "size_compact": "2457017",
            "evidence_level": "verified_db", "source_url": "https://www.upcitemdb.com/info-fortune_tires",
            "load_index": "", "speed_rating": "",
        }
        idn1 = {**base, "barcode": "840139631771"}
        idn2 = {**base, "barcode": "840139631788"}  # different barcode, same model+size
        counts = w.write_rows([idn1, idn2], paths, led, "run_test_db")
        assert counts["trusted"] == 2, f"expected 2 trusted, got {counts}"
        rows = list(csv.DictReader(open(paths["flat"], encoding="utf-8")))
        assert len(rows) == 2, f"expected 2 rows, got {len(rows)}"
        uid1 = rows[0]["canonical_product_uid"]
        uid2 = rows[1]["canonical_product_uid"]
        assert uid1 != uid2, f"UIDs must differ for different barcodes but both got {uid1!r}"
        assert rows[0]["manufacturer_part_number"] == "", \
            f"mpn should be empty but got {rows[0]['manufacturer_part_number']!r}"
        assert rows[1]["manufacturer_part_number"] == "", \
            f"mpn should be empty but got {rows[1]['manufacturer_part_number']!r}"
        # Barcodes must NOT appear in the mpn field
        assert rows[0]["manufacturer_part_number"] != rows[0]["barcode"], "mpn must not == barcode"
        assert rows[1]["manufacturer_part_number"] != rows[1]["barcode"], "mpn must not == barcode"


def test_rejected_and_backlog_are_written_to_files():
    with tempfile.TemporaryDirectory() as d:
        paths=_paths(d); led=L.load_ledger(os.path.join(d,"ledger.json"))
        ids=[
            {**GOOD},  # trusted
            {**GOOD,"barcode":"848983006250"},  # bad GTIN -> rejected
            {**GOOD,"manufacturer_part_number":"","mpn":"","retailer_sku":""},  # no mpn/sku -> backlog
        ]
        counts=w.write_rows(ids,paths,led,"run_test")
        assert counts=={"trusted":1,"backlog":1,"rejected":1,"dup_skipped":0}
        rej=list(csv.DictReader(open(os.path.join(d,"rejected_rows.csv"),encoding="utf-8")))
        bk=list(csv.DictReader(open(os.path.join(d,"tire_enrichment_backlog.csv"),encoding="utf-8")))
        assert len(rej)==1 and "gtin" in rej[0]["reject_reason"].lower()
        assert len(bk)==1 and bk[0]["reason"]
