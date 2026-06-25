import json, re

_LD = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                 re.S | re.I)
_GTIN_KEYS = ("gtin13", "gtin12", "gtin14", "gtin", "gtin8")

def _brand(v):
    if isinstance(v, dict):
        return str(v.get("name", "")).strip()
    return str(v or "").strip()

def _one(obj):
    if not isinstance(obj, dict):
        return None
    t = obj.get("@type", "")
    t = t if isinstance(t, str) else ",".join(t) if isinstance(t, list) else ""
    if "Product" not in t:
        return None
    gtin = ""
    for k in _GTIN_KEYS:
        if obj.get(k):
            gtin = str(obj[k]).strip(); break
    offers = obj.get("offers")
    oc = len(offers) if isinstance(offers, list) else (1 if offers else 0)
    return {"name": str(obj.get("name", "")).strip(),
            "brand": _brand(obj.get("brand")),
            "mpn": str(obj.get("mpn", "")).strip(),
            "sku": str(obj.get("sku", "")).strip(),
            "gtin": gtin, "offers_count": oc}

def _walk(node, out):
    if isinstance(node, dict):
        p = _one(node)
        if p:
            out.append(p)
        for v in node.values():
            _walk(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk(v, out)

def extract_products(html: str) -> list:
    out = []
    for block in _LD.findall(html or ""):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        _walk(data, out)
    # dedup by (gtin or name+mpn)
    seen, uniq = set(), []
    for p in out:
        key = p["gtin"] or (p["name"] + "|" + p["mpn"])
        if key and key not in seen:
            seen.add(key); uniq.append(p)
    return uniq
