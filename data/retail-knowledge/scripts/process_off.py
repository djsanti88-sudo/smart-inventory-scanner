"""Stream-process the Open Food Facts CSV dump into the retail catalog base.

Reads the gzipped, TAB-separated OFF export (no full decompression), keeps the useful columns,
GTIN-checksum-validates the barcode, dedups, and writes one JSON record per unique valid product to
retail_off.jsonl. SEPARATE from tires.
"""
import gzip, csv, json, os, sys, datetime
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass
csv.field_size_limit(10**7)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # data/retail-knowledge
GZ   = os.path.join(ROOT, "outputs", "off.csv.gz")
OUT  = os.path.join(ROOT, "retail_off.jsonl")
LOG  = os.path.join(ROOT, "outputs", "off_process.log")
KEEP = ["code","product_name","brands","brand_owner","categories_en","categories",
        "countries_en","quantity","image_url","image_small_url","main_category_en"]

def log(m):
    line=f"{datetime.datetime.now().isoformat(timespec='seconds')} {m}"
    open(LOG,"a",encoding="utf-8").write(line+"\n"); print(line, flush=True)

def gtin_valid(c):
    c=str(c or "").strip()
    if not c.isdigit() or len(c) not in (8,12,13,14): return False
    if len(set(c))==1: return False
    ds=[int(x) for x in c]; s=sum(d*(3 if i%2==0 else 1) for i,d in enumerate(reversed(ds[:-1])))
    return (10-(s%10))%10==ds[-1]

def main():
    if not os.path.exists(GZ): log(f"ERROR: {GZ} not found"); return
    log(f"START processing {GZ} ({os.path.getsize(GZ)//1024//1024} MB gz)")
    seen=set(); n=0; kept=0; invalid=0; dup=0
    with gzip.open(GZ,"rt",encoding="utf-8",errors="replace") as f, open(OUT,"w",encoding="utf-8") as o:
        r=csv.DictReader(f, delimiter="\t")
        for row in r:
            n+=1
            code=(row.get("code") or "").strip()
            if not gtin_valid(code): invalid+=1
            elif code in seen: dup+=1
            else:
                seen.add(code)
                rec={k:(row.get(k) or "").strip() for k in KEEP}
                rec["_source"]="openfoodfacts"
                o.write(json.dumps(rec, ensure_ascii=False)+"\n"); kept+=1
            if n % 250000 == 0:
                log(f"scanned={n} kept_unique_valid={kept} invalid_code={invalid} dup={dup}")
    log(f"DONE scanned={n} | KEPT unique valid barcodes={kept} | invalid={invalid} | dup={dup} -> {OUT}")

if __name__ == "__main__":
    main()
