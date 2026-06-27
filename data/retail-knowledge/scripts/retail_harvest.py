"""Retail barcode harvester (Barcode Lookup) - SEPARATE from tires.

Pulls FULL product records (all fields, incl. image URLs + store prices) into retail_corpus.jsonl,
deduped by barcode. Breadth-first round-robin over many retail search terms, deep pagination, throttled
to <=100 req/min (the API's documented cap - we do NOT evade it or rotate keys). Runs until the free
quota is exhausted (a quota/plan 429 stops it gracefully and reveals how big the sample was). Resumable:
seen-barcodes + per-term page progress persist to outputs/.
"""
import json, os, sys, time, urllib.request, urllib.error, urllib.parse, datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

KEY = os.environ.get("BL_KEY") or (sys.argv[1] if len(sys.argv) > 1 else "")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # data/retail-knowledge
OUT = os.path.join(ROOT, "outputs"); os.makedirs(OUT, exist_ok=True)
CORPUS = os.path.join(ROOT, "retail_corpus.jsonl")
SEEN_F = os.path.join(OUT, "seen_barcodes.json")
PROG_F = os.path.join(OUT, "progress.json")
LOG = os.path.join(OUT, "harvest.log")
BASE = "https://api.barcodelookup.com/v3/products"
MIN_INTERVAL = 0.65          # ~92 req/min, safely under the 100/min cap
MAX_PAGES_PER_TERM = 1000    # generous; quota will stop us first
RATE_BACKOFF = 60.0

TERMS = [
 # grocery / food
 "coffee","tea","water","soda","juice","beer","wine","snack","chips","candy","chocolate","cookies",
 "cereal","granola","oatmeal","pasta","rice","bread","flour","sugar","salt","sauce","ketchup","mustard",
 "mayonnaise","olive oil","vinegar","honey","peanut butter","jam","soup","beans","tuna","spices","seasoning",
 "milk","cheese","yogurt","butter","eggs","ice cream","frozen pizza","energy drink","protein bar","gum",
 # household / cleaning
 "detergent","laundry","dish soap","cleaner","bleach","disinfectant","paper towel","toilet paper","trash bags",
 "air freshener","sponge","glass cleaner","fabric softener","hand soap","tissues",
 # health / beauty / baby
 "vitamin","supplement","protein powder","pain reliever","bandage","first aid","thermometer","sunscreen",
 "shampoo","conditioner","body wash","lotion","deodorant","toothpaste","toothbrush","mouthwash","razor",
 "makeup","lipstick","mascara","foundation","nail polish","perfume","cologne","face mask","moisturizer",
 "diapers","baby wipes","baby formula","pacifier","baby food",
 # pet
 "dog food","cat food","dog treats","cat litter","pet shampoo","fish food","bird seed",
 # electronics
 "phone","smartphone","phone case","tablet","laptop","computer","monitor","keyboard","mouse","headphones",
 "earbuds","speaker","bluetooth speaker","tv","camera","webcam","charger","usb cable","hdmi cable","battery",
 "power bank","router","modem","ssd","hard drive","usb flash drive","memory card","smartwatch","printer","ink",
 # appliances / kitchen
 "blender","toaster","microwave","coffee maker","air fryer","vacuum","fan","heater","humidifier","kettle",
 "pan","pot","knife","cutting board","mug","plate","bowl","water bottle","food container","utensils",
 # tools / hardware / auto (NOT tires)
 "drill","saw","hammer","wrench","screwdriver","sander","tape measure","ladder","screws","nails","duct tape",
 "glue","paint","brush","light bulb","extension cord","flashlight","work gloves","safety glasses",
 "motor oil","oil filter","air filter","wiper blades","spark plug","car battery","brake pad","car wax",
 # office / school
 "pen","pencil","notebook","printer paper","stapler","marker","highlighter","folder","binder","scissors","calculator",
 # toys / games / books
 "lego","doll","puzzle","board game","action figure","video game","game controller","book","coloring book","stuffed animal",
 # sports / outdoors
 "basketball","football","soccer ball","dumbbell","yoga mat","resistance bands","bike helmet","tent","sleeping bag",
 "fishing rod","cooler","backpack","water filter",
 # apparel / accessories
 "t-shirt","jacket","jeans","socks","hat","gloves","shoes","sneakers","sandals","watch","sunglasses","wallet","belt","handbag",
 # major brands (surface branded SKUs)
 "coca-cola","pepsi","nestle","kraft","kellogg","general mills","procter gamble","unilever","loreal","colgate",
 "apple","samsung","sony","lg","microsoft","logitech","anker","hp","dell","nike","adidas","lego","hasbro","mattel",
]

def log(msg):
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f: f.write(line + "\n")
    except Exception: pass
    print(line, flush=True)

def load_seen():
    try: return set(json.load(open(SEEN_F, encoding="utf-8")))
    except Exception: return set()

def load_prog():
    try: return json.load(open(PROG_F, encoding="utf-8"))
    except Exception: return {}

def gtin_valid(code):
    code = str(code or "")
    if not code.isdigit() or len(code) not in (8,12,13,14): return False
    if len(set(code)) == 1: return False
    ds=[int(c) for c in code]; s=sum(d*(3 if i%2==0 else 1) for i,d in enumerate(reversed(ds[:-1])))
    return (10-(s%10))%10==ds[-1]

def fetch(term, page):
    q=urllib.parse.quote(term)
    url=f"{BASE}?search={q}&page={page}&formatted=y&key={KEY}"
    req=urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    r=urllib.request.urlopen(req, timeout=45)
    return json.loads(r.read().decode("utf-8","replace"))

def main():
    if not KEY: log("ERROR: no API key"); return
    seen=load_seen(); prog=load_prog()
    log(f"START retail harvest | terms={len(TERMS)} | seen(resume)={len(seen)} | corpus exists={os.path.exists(CORPUS)}")
    cf=open(CORPUS,"a",encoding="utf-8")
    calls=0; added=0; t0=time.time(); active=set(TERMS)
    next_call=0.0
    cycle=0
    try:
        while active:
            cycle+=1
            for term in list(TERMS):
                if term not in active: continue
                page=prog.get(term,1)
                # throttle
                wait=next_call-time.time()
                if wait>0: time.sleep(wait)
                next_call=time.time()+MIN_INTERVAL
                try:
                    d=fetch(term,page); calls+=1
                except urllib.error.HTTPError as e:
                    body=e.read().decode("utf-8","replace")[:200].lower()
                    if e.code==429:
                        if "rate" in body and "exceed" not in body and "limit reached" not in body and "plan" not in body:
                            log(f"429 rate-limit on '{term}' p{page}; backoff {RATE_BACKOFF}s"); time.sleep(RATE_BACKOFF); next_call=0; continue
                        log(f"429 QUOTA/PLAN exhausted on '{term}' p{page}: {body!r} -> STOP"); raise SystemExit
                    log(f"HTTP {e.code} on '{term}' p{page}: {body!r}; skipping term"); active.discard(term); continue
                except Exception as e:
                    log(f"ERR on '{term}' p{page}: {str(e)[:80]}; retry next cycle"); continue
                prods=d.get("products") or []
                if not prods:
                    active.discard(term); continue
                new=0
                for p in prods:
                    bc=str(p.get("barcode_number") or "").strip()
                    if not bc or bc in seen: continue
                    seen.add(bc)
                    rec=dict(p); rec["_source"]="barcodelookup"; rec["_term"]=term; rec["_gtin_valid"]=gtin_valid(bc)
                    rec["_fetched_at"]=datetime.datetime.now().isoformat(timespec="seconds")
                    cf.write(json.dumps(rec, ensure_ascii=False)+"\n"); new+=1; added+=1
                cf.flush()
                prog[term]=page+1
                if len(prods)<10 or page>=MAX_PAGES_PER_TERM:
                    active.discard(term)
                if calls % 25 == 0:
                    json.dump(sorted(seen), open(SEEN_F,"w")); json.dump(prog, open(PROG_F,"w"))
                    el=time.time()-t0
                    log(f"calls={calls} added={added} unique={len(seen)} active_terms={len(active)} rate={round(calls/el*60,1)}/min last:'{term}'p{page}+{new}")
    except SystemExit:
        pass
    finally:
        json.dump(sorted(seen), open(SEEN_F,"w")); json.dump(prog, open(PROG_F,"w")); cf.close()
        el=time.time()-t0
        log(f"DONE/STOP | calls={calls} | unique products={len(seen)} | added_this_run={added} | elapsed={round(el/60,1)}min | avg {round(calls/max(el,1)*60,1)} req/min")

if __name__ == "__main__":
    main()
