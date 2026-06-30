import sys, os, json, re, time, urllib.request
sys.path.insert(0, "scripts")
import gemini_barcode_lookup as G
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

KEY_FC = sys.argv[1]
CREDIT_CAP = 90
N = 25
OUT = "outputs/_bakeoff_result.json"

def gtin_valid(code):
    if not code.isdigit() or len(code) not in (12,13,14): return False
    ds=[int(c) for c in code]; chk=ds[-1]; body=ds[:-1][::-1]
    s=sum(d*(3 if i%2==0 else 1) for i,d in enumerate(body))
    return (10-(s%10))%10==chk

def extract_barcode(text):
    """gtin-valid digit run that sits NEAR a upc/ean/gtin/barcode keyword (precision)."""
    if not text: return None
    low=text.lower()
    best=None
    for m in re.finditer(r'\d[\d\s-]{10,16}\d', text):
        raw=re.sub(r'\D','',m.group(0))
        if len(raw) not in (12,13,14) or not gtin_valid(raw): continue
        ctx=low[max(0,m.start()-40):m.start()]
        if re.search(r'upc|ean|gtin|barcode', ctx):
            return raw  # keyword-anchored, validated -> trust
        if best is None: best=raw
    return None  # require keyword anchor (strict); ignore unanchored

def fc_rem():
    r=urllib.request.Request("https://api.firecrawl.dev/v2/team/credit-usage",headers={"Authorization":f"Bearer {KEY_FC}"})
    return json.load(urllib.request.urlopen(r,timeout=20))["data"]["remainingCredits"]

def fc_lookup(q):
    body=json.dumps({"query":q,"limit":1,"scrapeOptions":{"formats":["markdown"]}}).encode()
    req=urllib.request.Request("https://api.firecrawl.dev/v2/search",data=body,method="POST",
        headers={"Authorization":f"Bearer {KEY_FC}","Content-Type":"application/json"})
    resp=json.load(urllib.request.urlopen(req,timeout=70))
    used=resp.get("creditsUsed",0)
    web=(resp.get("data") or {}).get("web") or []
    bc=None; src=None
    for r in web:
        bc=extract_barcode(r.get("markdown") or "")
        if bc: src=r.get("url"); break
    return bc, used, src

key_g = G.load_api_key()
rows=list(__import__("csv").DictReader(open("outputs/tirelibrary_missing_barcodes.csv",encoding="utf-8")))
sample=G.select_consumer_sample(rows, N)
print(f"sample size: {len(sample)}", flush=True)

results=[]; fc_credits=0; g429=0
for i,row in enumerate(sample):
    q=G.build_query(row)
    rec={"q":q[:70]}
    # Gemini arm (free)
    try:
        resp=G.gemini_grounded_lookup(q, key_g)
        p=G.parse_response(resp); gb=p.get("barcode") or ""
        rec["gemini"]= gb if (gb and gtin_valid(gb)) else None
    except Exception as e:
        m=str(e); rec["gemini"]="429" if "429" in m else f"err:{m[:30]}"
        if "429" in m: g429+=1
    # Firecrawl arm (capped)
    if fc_credits < CREDIT_CAP - 5:
        try:
            bc,used,src=fc_lookup(q); fc_credits+=used
            rec["fc"]=bc; rec["fc_credits"]=used; rec["fc_src"]=(src or "")[:50]
        except Exception as e:
            rec["fc"]=f"err:{str(e)[:30]}"; rec["fc_credits"]=0
    else:
        rec["fc"]="SKIP_capreached"
    results.append(rec)
    print(f"[{i+1}/{len(sample)}] gem={rec.get('gemini')} fc={rec.get('fc')} fc_cr={rec.get('fc_credits',0)} total_fc_credits={fc_credits}", flush=True)
    if fc_credits >= CREDIT_CAP - 5: 
        pass

def isbc(v): return isinstance(v,str) and v.isdigit() and len(v) in (12,13,14)
gem_found=sum(1 for r in results if isbc(r.get("gemini")))
fc_found=sum(1 for r in results if isbc(r.get("fc")))
both=sum(1 for r in results if isbc(r.get("gemini")) and isbc(r.get("fc")))
gem_only=sum(1 for r in results if isbc(r.get("gemini")) and not isbc(r.get("fc")))
fc_only=sum(1 for r in results if isbc(r.get("fc")) and not isbc(r.get("gemini")))
summary={"n":len(results),"gemini_found":gem_found,"gemini_429":g429,"fc_found":fc_found,
         "both":both,"gemini_only":gem_only,"fc_only_incremental":fc_only,
         "fc_credits_spent":fc_credits,"fc_credits_per_found": round(fc_credits/fc_found,1) if fc_found else None}
json.dump({"summary":summary,"results":results}, open(OUT,"w"), indent=1)
print("SUMMARY:", json.dumps(summary), flush=True)
print("remaining FC credits:", fc_rem(), flush=True)
