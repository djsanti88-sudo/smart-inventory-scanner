"""Scrape a URL (rendered) and count GTIN-VALID 12-14 digit barcodes present = density probe."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import firecrawl_client as fc
import validate as v

url = sys.argv[1]
fmt = sys.argv[2] if len(sys.argv) > 2 else "markdown"
rs = {"run_credits_spent": 0}
r = fc.call(["scrape", "--format", fmt, url], expected_max_credits=2, run_state=rs)
text = r["stdout"] or ""
print("credits", r["credits_spent"], "| len", len(text))
nums = set(re.findall(r"(?<!\d)\d{12,14}(?!\d)", text))
valid = [n for n in nums if v.gtin_check_digit_valid(n)]
print("distinct 12-14 digit numbers:", len(nums), "| GTIN-VALID:", len(valid))
print("=> rows-per-credit (valid GTINs / credit):", round(len(valid) / max(1, r["credits_spent"]), 1))
for n in valid[:8]:
    print("   ", n)
print("remaining", fc.get_remaining_credits())
