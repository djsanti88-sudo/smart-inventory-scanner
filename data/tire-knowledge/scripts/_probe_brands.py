import os, re, json, requests, certifi
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
key=re.search(r"TIRELIBRARY_API_KEY\s*=\s*(\S+)",open(os.path.join(ROOT,"..","..",".env.local"),encoding="utf-8").read()).group(1).strip().strip('"').strip("'")
H={"x-api-key":key,"Accept":"application/json"}
B="https://app.tireweblibrary.com/api/v1"
def total(mk):
    r=requests.get(f"{B}/tires/catalog",headers=H,params={"per_page":1,"page":1,"make_name":mk},timeout=30,verify=certifi.where())
    d=r.json().get("results",{}); return r.status_code, d.get("total"), (d.get("data") or [{}])[0].get("make_name")
print("=== missing priority brands (exact + variants) ===")
for mk in ["NOKIAN","NOKIAN TYRES","FORTUNE","TOYO","TOYO TIRES","NEXEN","NEXEN TIRE"]:
    print(mk, "->", total(mk))
# try a makes endpoint for the FULL brand list
print("\n=== makes endpoint discovery ===")
for ep in ["/tires/makes","/makes","/tire-makes","/tires/facets","/brands"]:
    try:
        r=requests.get(f"{B}{ep}",headers=H,timeout=20,verify=certifi.where())
        print(ep,"->",r.status_code, (str(r.json())[:160] if r.status_code==200 else r.text[:80]))
    except Exception as e: print(ep,"ERR",str(e)[:60])
