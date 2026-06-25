import csv, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import validate as v, ledger as L

def audit(root):
    errs=[]
    flat=os.path.join(root,"tire_corpus_flat.csv")
    with open(flat,newline="",encoding="utf-8") as f:
        rdr=csv.reader(f); header=next(rdr,[])
        if header!=v.FLAT_COLS: errs.append(f"schema header mismatch: {header}")
    with open(flat,newline="",encoding="utf-8") as f:
        rows=list(csv.DictReader(f))
    seen_bc=set(); seen_uid=set()
    for r in rows:
        bc=r["barcode"]
        if bc in seen_bc: errs.append(f"dup barcode {bc}")
        seen_bc.add(bc)
        if r["canonical_product_uid"] in seen_uid: errs.append(f"dup uid {r['canonical_product_uid']}")
        seen_uid.add(r["canonical_product_uid"])
        if not v.gtin_check_digit_valid(bc): errs.append(f"bad GTIN {bc}")
        if not r["size_canonical"] or not r["size_compact"]: errs.append(f"missing size {bc}")
    led=L.load_ledger(os.path.join(root,"coverage_ledger.json"))
    ok,msg=L.counts_match_csv(led, flat)
    if not ok: errs.append(msg)
    return (len(errs)==0, errs)

if __name__=="__main__":
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ok,errs=audit(root)
    print("AUDIT PASS" if ok else "AUDIT FAIL")
    for e in errs: print("  -",e)
    sys.exit(0 if ok else 1)
