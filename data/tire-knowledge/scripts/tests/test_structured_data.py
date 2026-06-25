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
