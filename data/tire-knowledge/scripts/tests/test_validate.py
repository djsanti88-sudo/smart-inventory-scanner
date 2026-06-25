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
