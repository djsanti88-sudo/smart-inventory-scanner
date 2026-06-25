"""Sample Tirelibrary details across the whole catalog to measure barcode coverage."""
import os, re, json, time, sys
import requests, certifi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", "..", ".env.local")
BASE = "https://app.tireweblibrary.com/api/v1"
txt = open(ENV, encoding="utf-8").read()
key = re.search(r"TIRELIBRARY_API_KEY\s*=\s*(\S+)", txt).group(1).strip().strip('"').strip("'")
H = {"x-api-key": key, "Accept": "application/json"}

PER = 100
SAMPLE_PAGES = [1, 600, 1200, 1800, 2400, 3000]   # spread across ~3085 pages
TAKE_PER_PAGE = 15                                  # ~90 detail calls total

ids = []
for pg in SAMPLE_PAGES:
    r = requests.get(f"{BASE}/tires/catalog", headers=H, params={"per_page": PER, "page": pg},
                     timeout=40, verify=certifi.where())
    if r.status_code != 200:
        print("catalog page", pg, "->", r.status_code); continue
    rows = r.json()["results"]["data"]
    for t in rows[:TAKE_PER_PAGE]:
        ids.append((t["id"], t.get("make_name"), t.get("model_name")))
    time.sleep(0.4)

print(f"sampling {len(ids)} tire details...\n")
n = upc = ean = gm = asin = either = neither = 0
samples = []
for tid, mk, md in ids:
    try:
        r = requests.get(f"{BASE}/tires/{tid}", headers=H, timeout=30, verify=certifi.where())
        if r.status_code != 200:
            print("detail", tid, "->", r.status_code); time.sleep(1.0); continue
        d = r.json().get("results", r.json())
        n += 1
        u, e, g, a = d.get("upc"), d.get("ean"), d.get("gm_code"), d.get("asin")
        if u: upc += 1
        if e: ean += 1
        if g: gm += 1
        if a: asin += 1
        if u or e: either += 1
        else: neither += 1
        if len(samples) < 8 and (u or e):
            samples.append({
                "brand": d.get("make_name") or mk, "model": d.get("model_name") or md,
                "size": f'{d.get("width")}/{d.get("aspect_ratio")}R{d.get("rim_size")}',
                "load": d.get("load_rating"), "speed": d.get("speed_rating"),
                "upc": u, "ean": e, "asin": a,
            })
    except Exception as ex:
        print("err", tid, ex)
    time.sleep(1.0)   # ~60/min

print(f"\n=== BARCODE COVERAGE (n={n}) ===")
def pct(x): return f"{x} ({100*x/n:.0f}%)" if n else "0"
print("has UPC      :", pct(upc))
print("has EAN      :", pct(ean))
print("has UPC|EAN  :", pct(either), "  <-- usable for scanner")
print("has GM code  :", pct(gm))
print("has ASIN     :", pct(asin))
print("NO barcode   :", pct(neither))
print(f"\nProjected usable barcodes across {308420:,} tires: ~{int(308420*either/n):,}" if n else "")
print("\n=== SAMPLE MAPPED ROWS ===")
for s in samples:
    print(json.dumps(s))
