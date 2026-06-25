import csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_tiresandwheels_url import parse_url
import write_outputs as w, ledger as L, audit_corpus

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED=os.path.join(ROOT,"seed","TIRE_C_1.csv")

def main():
    with open(SEED,newline="",encoding="utf-8") as f:
        src=list(csv.DictReader(f))
    identities=[]
    for r in src:
        idn=parse_url(r["source_url"])
        if not idn:
            continue
        # URL is source of truth for identity; carry enrichment fields from the seed row
        for fld in ("load_index","speed_rating","tire_type","season"):
            idn[fld]=r.get(fld,"")
        idn["manufacturer_part_number"]=idn["mpn"]
        identities.append(idn)
    led=L.load_ledger(os.path.join(ROOT,"coverage_ledger.json"))
    paths={"flat":os.path.join(ROOT,"tire_corpus_flat.csv"),
           "identifiers":os.path.join(ROOT,"tire_identifiers.csv"),
           "size_aliases":os.path.join(ROOT,"tire_size_aliases.csv")}
    counts=w.write_rows(identities, paths, led, "seed_example_001")
    L.save_ledger(led, os.path.join(ROOT,"coverage_ledger.json"))
    print("SEED COUNTS", counts)
    ok,errs=audit_corpus.audit(ROOT)
    print("AUDIT PASS" if ok else "AUDIT FAIL"); [print("  -",e) for e in errs]
    sys.exit(0 if ok else 1)

if __name__=="__main__":
    main()
