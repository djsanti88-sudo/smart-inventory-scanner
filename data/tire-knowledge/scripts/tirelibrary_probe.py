"""Probe the Tirelibrary REST API: verify key + reveal the JSON field schema. Reads key from .env.local (never prints it)."""
import os, re, json, sys
import requests, certifi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", "..", ".env.local")
BASE = "https://app.tireweblibrary.com/api/v1"

txt = open(ENV, encoding="utf-8").read()
m = re.search(r"TIRELIBRARY_API_KEY\s*=\s*(\S+)", txt)
key = m.group(1).strip().strip('"').strip("'") if m else ""
print("key present:", bool(key), "| looks like full tl_live_ key:", key.startswith("tl_live_") and len(key) > 20, "| len:", len(key))
if not key:
    sys.exit("no key")

r = requests.get(f"{BASE}/tires/catalog", headers={"x-api-key": key, "Accept": "application/json"},
                 params={"per_page": 3, "page": 1}, timeout=40, verify=certifi.where())
print("HTTP", r.status_code)
if r.status_code != 200:
    print("body:", r.text[:400]); sys.exit("non-200")
data = r.json()
print("top-level keys:", list(data.keys()))

def describe(name, v, depth=0):
    pad = "  " * depth
    if isinstance(v, dict):
        print(f"{pad}{name}: dict keys={list(v.keys())}")
    elif isinstance(v, list):
        print(f"{pad}{name}: list len={len(v)}")
        if v and isinstance(v[0], dict):
            print(f"{pad}  [0] keys={list(v[0].keys())}")
    else:
        print(f"{pad}{name}: {type(v).__name__} = {repr(v)[:80]}")

res = data.get("results")
describe("results", res)
if isinstance(res, dict):
    for k, v in res.items():
        describe(k, v, 1)
    # find the list of tires inside results
    for k, v in res.items():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            print("\n=== TIRE ITEM under results['%s'] ===" % k)
            print("FIELD NAMES:", list(v[0].keys()))
            print("SAMPLE:", json.dumps(v[0], indent=2)[:1800])
            break
elif isinstance(res, list) and res:
    print("FIELD NAMES:", list(res[0].keys()))
    print("SAMPLE:", json.dumps(res[0], indent=2)[:1800])
