"""
Phase B probe: scrape candidate URLs as raw HTML (via the credit firewall) and
report how many products + GTINs are in their JSON-LD. Used to find sources that
clear the >=8 rows/credit bulk floor BEFORE committing budget.

Usage: uv run python scripts/phaseb_probe.py <url> [<url> ...]
"""
import sys, os, csv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import firecrawl_client as fc
from structured_data import extract_products

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "outputs", "phaseb_probe_results.csv")


def probe(urls):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    run_state = {"run_credits_spent": 0}
    rows = []
    for url in urls:
        try:
            r = fc.call(["scrape", "--format", "rawHtml", url],
                        expected_max_credits=2, run_state=run_state, root=ROOT)
            html = r.get("stdout", "")
            spent = r.get("credits_spent", 0)
            prods = extract_products(html)
            with_gtin = [p for p in prods if p["gtin"]]
            rpc = round(len(with_gtin) / spent, 1) if spent else 0
            rows.append({"url": url, "html_len": len(html), "products": len(prods),
                         "gtins": len(with_gtin), "credits": spent, "rows_per_credit": rpc})
            print(f"[{len(with_gtin):4d} gtins / {spent} cr = {rpc:>5} rpc] {url[:80]}")
            if with_gtin[:2]:
                for p in with_gtin[:2]:
                    print(f"     e.g. brand={p['brand']!r} gtin={p['gtin']!r} mpn={p['mpn']!r} name={p['name'][:50]!r}")
            elif prods[:1]:
                print(f"     products found but NO gtin (sample: {prods[0]['name'][:50]!r})")
            else:
                print("     no JSON-LD products found")
        except Exception as e:
            rows.append({"url": url, "html_len": 0, "products": 0, "gtins": 0,
                         "credits": 0, "rows_per_credit": 0})
            print(f"[ERROR] {url[:80]} -> {str(e)[:100]}")
    with open(OUT, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["url", "html_len", "products", "gtins", "credits", "rows_per_credit"])
        if f.tell() == 0:
            w.writeheader()
        w.writerows(rows)
    print(f"\nremaining credits: {fc.get_remaining_credits()}  (results appended to {OUT})")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: uv run python scripts/phaseb_probe.py <url> [<url> ...]")
        sys.exit(1)
    probe(sys.argv[1:])
