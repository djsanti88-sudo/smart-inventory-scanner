"""Inspect catalog facets + test make/brand filtering so we can prioritize brands."""
import os, re, json
import requests, certifi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", "..", ".env.local")
BASE = "https://app.tireweblibrary.com/api/v1"
key = re.search(r"TIRELIBRARY_API_KEY\s*=\s*(\S+)", open(ENV, encoding="utf-8").read()).group(1).strip().strip('"').strip("'")
H = {"x-api-key": key, "Accept": "application/json"}

# 1) facets structure
r = requests.get(f"{BASE}/tires/catalog", headers=H, params={"per_page": 1, "page": 1}, timeout=40, verify=certifi.where())
fac = r.json().get("facets", {})
print("facets type:", type(fac).__name__)
if isinstance(fac, dict):
    print("facets keys:", list(fac.keys()))
    for k, v in fac.items():
        if isinstance(v, list):
            print(f"  {k}: list len={len(v)}; sample={json.dumps(v[:2])[:300]}")
        else:
            print(f"  {k}: {type(v).__name__} {repr(v)[:120]}")

# 2) test brand-filter param names against total counts
print("\n=== filter tests (watch 'total' shrink from 308420) ===")
for params in [
    {"make_name": "FALKEN"}, {"make": "FALKEN"}, {"brand": "FALKEN"},
    {"tire_make_id": 485}, {"make_id": 485}, {"makes": "FALKEN"},
    {"search": "FALKEN"}, {"q": "FALKEN"},
]:
    p = {"per_page": 1, "page": 1, **params}
    try:
        rr = requests.get(f"{BASE}/tires/catalog", headers=H, params=p, timeout=30, verify=certifi.where())
        tot = rr.json().get("results", {}).get("total") if rr.status_code == 200 else None
        first = rr.json().get("results", {}).get("data", [{}])
        mk = first[0].get("make_name") if first else None
        print(f"{params} -> {rr.status_code} total={tot} firstMake={mk}")
    except Exception as e:
        print(params, "ERR", e)
