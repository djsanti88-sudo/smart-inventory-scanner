"""Full deterministic QA over the ENTIRE corpus (free, no API). Reports any problems."""
import csv, os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate as v
from parse_tiresandwheels_url import parse_url

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(os.path.join(ROOT, "tire_corpus_flat.csv"), encoding="utf-8")))
n = len(rows)

bad_gtin = [r["barcode"] for r in rows if not v.gtin_check_digit_valid(r["barcode"])]

bc_counts = collections.Counter(r["barcode"] for r in rows)
dup_bc = [b for b, c in bc_counts.items() if c > 1]
uid_counts = collections.Counter(r["canonical_product_uid"] for r in rows)
dup_uid = [u for u, c in uid_counts.items() if c > 1]

missing_req = [r["barcode"] for r in rows if not all(r.get(f, "").strip()
               for f in ("brand", "model", "size_canonical", "size_compact"))]
missing_mpn_sku = sum(1 for r in rows if not r.get("manufacturer_part_number", "").strip())

# Strong check: re-parse the source URL and confirm the URL-encoded barcode matches the column.
url_mismatch = []
size_mismatch = []
for r in rows:
    p = parse_url(r["source_url"])
    if p:
        if p.get("barcode") != r["barcode"]:
            url_mismatch.append((r["barcode"], p.get("barcode"), r["source_url"]))
        if p.get("size_compact") != r["size_compact"]:
            size_mismatch.append((r["size_canonical"], r["size_compact"], p.get("size_compact")))

# barcode_type matches length
type_bad = [r["barcode"] for r in rows if r["barcode_type"] != v.barcode_type_label(r["barcode"])]

# size_compact actually derives from size_canonical
size_derive_bad = []
for r in rows:
    _, k = v.normalize_size(r["size_canonical"])
    if k != r["size_compact"]:
        size_derive_bad.append((r["size_canonical"], r["size_compact"], k))

# Conflict: same barcode -> different (brand, model)?
by_bc = collections.defaultdict(set)
for r in rows:
    by_bc[r["barcode"]].add((r["brand"], r["model"]))
conflicts = {b: ids for b, ids in by_bc.items() if len(ids) > 1}

# Enrichment sanity (only on filled values)
load_bad = [r["barcode"] for r in rows if r.get("load_index", "").strip()
            and not r["load_index"].replace("/", "").isdigit()]
speed_bad = [r["barcode"] for r in rows if r.get("speed_rating", "").strip()
             and not r["speed_rating"].isalpha()]

print("=" * 60)
print(f"FULL CORPUS QA  —  {n} rows")
print("=" * 60)
checks = [
    ("invalid GTIN check digit", len(bad_gtin)),
    ("duplicate barcodes", len(dup_bc)),
    ("duplicate canonical_product_uid", len(dup_uid)),
    ("rows missing brand/model/size", len(missing_req)),
    ("URL barcode != column barcode", len(url_mismatch)),
    ("URL size != column size_compact", len(size_mismatch)),
    ("barcode_type wrong for length", len(type_bad)),
    ("size_compact not derivable from canonical", len(size_derive_bad)),
    ("same barcode -> different brand/model (CONFLICT)", len(conflicts)),
    ("load_index not numeric", len(load_bad)),
    ("speed_rating not alpha", len(speed_bad)),
]
allzero = True
for name, cnt in checks:
    flag = "OK" if cnt == 0 else "!! FAIL"
    if cnt: allzero = False
    print(f"  [{flag:7s}] {name}: {cnt}")
print("-" * 60)
print("rows with MPN:", n - missing_mpn_sku, "/", n)
print("VERDICT:", "ALL DETERMINISTIC CHECKS PASS" if allzero else "ISSUES FOUND (see above)")

# show a few examples if any failures
if url_mismatch[:3]:
    print("\nsample URL mismatches:", url_mismatch[:3])
if conflicts:
    ex = list(conflicts.items())[:3]
    print("\nsample conflicts:", ex)
