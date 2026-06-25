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
