"""Probe Tirelibrary tire DETAIL endpoint to find where UPC / barcode lives."""
import os, re, json, sys
import requests, certifi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", "..", ".env.local")
BASE = "https://app.tireweblibrary.com/api/v1"

txt = open(ENV, encoding="utf-8").read()
m = re.search(r"TIRELIBRARY_API_KEY\s*=\s*(\S+)", txt)
key = m.group(1).strip().strip('"').strip("'")
H = {"x-api-key": key, "Accept": "application/json"}
TID = 173258  # ACCELERA Eco Plush from catalog page 1

candidates = [
    f"{BASE}/tires/{TID}",
    f"{BASE}/tires/details/{TID}",
    f"{BASE}/tires/detail/{TID}",
    f"{BASE}/tire/{TID}",
]
for url in candidates:
    try:
        r = requests.get(url, headers=H, timeout=30, verify=certifi.where())
    except Exception as e:
        print(url, "ERR", e); continue
    print("\n", url, "->", r.status_code)
    if r.status_code == 200:
        d = r.json()
        body = d.get("results", d.get("data", d))
        if isinstance(body, dict):
            print("DETAIL FIELDS:", list(body.keys()))
            # surface any barcode-ish fields
            hits = {k: v for k, v in body.items() if re.search(r"upc|ean|gtin|barcode|mpc|part|code|number|sku", k, re.I)}
            print("ID-LIKE FIELDS:", json.dumps(hits, indent=2)[:1200])
        else:
            print("body type:", type(body).__name__, json.dumps(d, indent=2)[:800])
        break
    else:
        print("  body:", r.text[:200])
