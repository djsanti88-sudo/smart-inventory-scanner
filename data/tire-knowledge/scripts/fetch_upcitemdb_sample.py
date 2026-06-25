"""Fetch one upcitemdb brand page, save raw HTML as a fixture, and print the
name<->UPC row structure so we can build a parser. Free (requests), robots-allowed (/info-*)."""
import requests, certifi, re, os

H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
url = "https://www.upcitemdb.com/info-fortune_tires"
r = requests.get(url, headers=H, timeout=25, verify=certifi.where())
html = r.text
fixt = os.path.join(ROOT, "scripts", "tests", "fixtures", "upcitemdb_fortune.html")
os.makedirs(os.path.dirname(fixt), exist_ok=True)
open(fixt, "w", encoding="utf-8").write(html)
print("saved fixture", len(html), "bytes ->", fixt)

# Find the first occurrence of a known UPC and print surrounding HTML to reveal structure.
m = re.search(r"840139631771|840063601130|\d{12}", html)
if m:
    i = m.start()
    print("=== HTML around first barcode ===")
    print(html[max(0, i - 400):i + 200])
