"""Diagnostic: scrape one URL (rendered html) and report which barcode-ish tokens appear."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import firecrawl_client as fc

url = sys.argv[1]
fmt = sys.argv[2] if len(sys.argv) > 2 else "html"
rs = {"run_credits_spent": 0}
r = fc.call(["scrape", "--format", fmt, url], expected_max_credits=2, run_state=rs)
h = r["stdout"] or ""
low = h.lower()
print("credits", r["credits_spent"], "| len", len(h))
for tok in ["__next_data__", '"upc"', '"gtin', '"ean"', "partnumber", '"sku"',
            "specification", "mpn", "barcode"]:
    print(f"  {tok!r}: {low.count(tok)}")
for key in ["upc", "gtin", "ean"]:
    i = low.find(key)
    if i > 0:
        print(f"--- around '{key}' ---", h[max(0, i - 70):i + 90].replace("\n", " "))
print("remaining", fc.get_remaining_credits())
