#!/usr/bin/env python3
"""
Tire Barcode Harvester - Validation & Normalization Utilities
No paid APIs. Pure local Python.
"""
import re, csv, json, sys, hashlib
from datetime import datetime, timezone

# ── GTIN check digit (right-to-left, weights 3,1,3,1...) ─────────────────────
def gtin_check_digit_valid(barcode: str) -> bool:
    b = barcode.strip()
    if not b.isdigit():
        return False
    if len(b) not in (8, 12, 13, 14):
        return False
    if len(set(b)) == 1:          # all-same digit (e.g. 000000000000) → reject
        return False
    digits = [int(c) for c in b]
    total = 0
    for i, d in enumerate(reversed(digits[:-1])):
        weight = 3 if i % 2 == 0 else 1
        total += d * weight
    computed = (10 - (total % 10)) % 10
    return computed == digits[-1]

def barcode_type_label(barcode: str) -> str:
    b = barcode.strip()
    if not b.isdigit(): return "unknown"
    if len(b) == 12:  return "upc"
    if len(b) == 13:  return "ean"
    if len(b) == 14:  return "gtin14"
    if len(b) == 8:   return "ean8"
    return "unknown"

# ── Size normalization ────────────────────────────────────────────────────────
SIZE_RE = re.compile(
    r'^(P|LT|ST|C|T)?'
    r'(\d{2,3}(?:\.\d+)?)'
    r'[/xX]'
    r'(\d{2}(?:\.\d+)?)'
    r'[Rr]'
    r'(\d{2}(?:\.\d+)?)'
    r'(?:\s+\d+(?:[/]\d+)?\s*[A-Z]+)?$'
)
FLOT_RE  = re.compile(r'^(\d{2})x(\d{2}(?:\.\d+)?)R(\d{2,2})$', re.IGNORECASE)
COMM_RE  = re.compile(r'^(\d{2,3}(?:/\d{2,3})?)R(\d{2}(?:\.\d)?)$', re.IGNORECASE)

def normalize_size(raw: str):
    s = raw.strip().replace('×','x').replace(' ','')
    m = FLOT_RE.match(s)
    if m:
        od, sw, rim = m.group(1), m.group(2), m.group(3)
        canonical = f"{od}x{sw}R{rim}"
        compact   = re.sub(r'[^0-9]', '', canonical)
        return canonical, compact
    m2 = COMM_RE.match(s)
    if m2:
        wr, rim = m2.group(1), m2.group(2)
        canonical = f"{wr}R{rim}"
        compact   = re.sub(r'[^0-9]', '', canonical)
        return canonical, compact
    m3 = SIZE_RE.match(s)
    if m3:
        prefix = (m3.group(1) or '').upper()
        sw, ar, rim = m3.group(2), m3.group(3), m3.group(4)
        canonical = f"{prefix}{sw}/{ar}R{rim}"
        compact   = re.sub(r'[^0-9]', '', f"{sw}/{ar}R{rim}")
        return canonical, compact
    return None, None

# ── Brand / Model normalization ───────────────────────────────────────────────
BRAND_MAP = {
    'bfgoodrich':  ['bfgoodrich','bf goodrich','bfg'],
    'goodyear':    ['goodyear','goodyear tire'],
    'continental': ['continental','continental tire'],
    'michelin':    ['michelin','michelin north america'],
    'bridgestone': ['bridgestone','bridgestone tire'],
    'firestone':   ['firestone','firestone tire'],
    'general':     ['general','general tire'],
    'dunlop':      ['dunlop','dunlop tire'],
    'kelly':       ['kelly','kelly tire','kelly-springfield'],
    'uniroyal':    ['uniroyal','uniroyal tire'],
    'pirelli':     ['pirelli','pirelli tire'],
    'toyo':        ['toyo','toyo tire','toyo tires'],
    'nitto':       ['nitto','nitto tire','nitto tires'],
    'yokohama':    ['yokohama','yokohama tire','yokohama tires'],
    'cooper':      ['cooper','cooper tire','cooper tires'],
    'falken':      ['falken','falken tire','falken tires'],
    'hankook':     ['hankook','hankook tire','hankook tires'],
    'kumho':       ['kumho','kumho tire','kumho tires'],
    'nexen':       ['nexen','nexen tire','nexen tires'],
    'sailun':      ['sailun','sailun tire'],
    'ironman':     ['ironman','ironman tires'],
    'hercules':    ['hercules','hercules tire','hercules tires'],
    'mastercraft': ['mastercraft','mastercraft tires'],
    'sumitomo':    ['sumitomo','sumitomo tire'],
    'laufenn':     ['laufenn','laufenn tire'],
    'blackhawk':   ['blackhawk','black hawk','blackhawk tire'],
    'westlake':    ['westlake','westlake tire'],
    'milestar':    ['milestar','milestar tires'],
    'goodride':    ['goodride'],
    'gt radial':   ['gt radial','gtradial'],
    'linglong':    ['linglong'],
    'prinx':       ['prinx','prinx tire'],
    'fortune':     ['fortune','fortune tire'],
    'delinte':     ['delinte'],
    'sentury':     ['sentury'],
    'ohtsu':       ['ohtsu','ohtsu tire'],
    'nokian':      ['nokian','nokian tyres','nokian tire'],
    'kenda':       ['kenda','kenda tire'],
    'maxxis':      ['maxxis','maxxis tire'],
    'carlisle':    ['carlisle','carlisle tire'],
    'radar':       ['radar','radar tire'],
    'roadx':       ['roadx','road x'],
}
_BRAND_LOOKUP = {a.lower(): norm for norm, aliases in BRAND_MAP.items() for a in aliases}

def normalize_brand(raw: str) -> str:
    return _BRAND_LOOKUP.get(raw.strip().lower(), raw.strip().lower())

def normalize_model(raw: str) -> str:
    s = raw.strip()
    s = re.sub(r'[/]', '_', s)
    s = re.sub(r'\s+', '_', s)
    s = re.sub(r'[^a-zA-Z0-9_\-]', '', s)
    return s.lower()

def make_identity_key(brand, model, size_canonical, load_index='', speed_rating='', mpn=''):
    parts = [normalize_brand(brand), normalize_model(model), size_canonical,
             str(load_index).strip(), str(speed_rating).strip()]
    if mpn: parts.append(str(mpn).strip())
    return '|'.join(parts)

def make_uid(brand, model, size_canonical, load_index='', speed_rating='', mpn=''):
    nb = normalize_brand(brand)
    nm = normalize_model(model)
    size_slug = re.sub(r'[^a-z0-9]', '_', size_canonical.lower())
    li = re.sub(r'[^a-z0-9_]', '', str(load_index).lower())
    sr = re.sub(r'[^a-z0-9]', '', str(speed_rating).lower())
    parts = [nb, nm, size_slug]
    if li:  parts.append(li)
    if sr:  parts.append(sr)
    if mpn: parts.append(re.sub(r'[^a-z0-9]', '', str(mpn).lower()))
    return '_'.join(p for p in parts if p)

FLAT_COLS = [
    'canonical_product_uid','brand','model','size_canonical','size_compact',
    'load_index','speed_rating','tire_type','season','barcode','barcode_type',
    'manufacturer_part_number','source_url','evidence_level','usable_for',
    'current_status','missing_fields','field_completeness_score','harvested_at','run_id'
]
REQUIRED_FLAT = ['canonical_product_uid','brand','model','size_canonical','size_compact',
                 'barcode','barcode_type','source_url','evidence_level','usable_for',
                 'current_status','harvested_at','run_id']

def completeness_score(row: dict) -> float:
    fields = ['brand','model','size_canonical','size_compact','load_index','speed_rating',
              'tire_type','season','barcode','barcode_type','manufacturer_part_number',
              'source_url','evidence_level','usable_for','current_status']
    filled = sum(1 for f in fields if str(row.get(f,'')).strip())
    return round(filled / len(fields), 2)

def missing_fields_str(row: dict) -> str:
    optional = ['load_index','speed_rating','tire_type','season','manufacturer_part_number']
    return ','.join(f for f in optional if not str(row.get(f,'')).strip())

def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def is_trusted_db_identity(row: dict):
    """DB-sourced trusted bar: valid GTIN + brand + model + size_canonical + size_compact (NO MPN/SKU)."""
    bc = str(row.get("barcode", "")).strip()
    if not gtin_check_digit_valid(bc):
        return False, "barcode missing or fails GTIN check"
    for fld in ("brand", "model", "size_canonical", "size_compact"):
        if not str(row.get(fld, "")).strip():
            return False, f"missing {fld}"
    return True, ""

def is_trusted_identity(row: dict):
    """Trusted bar: valid GTIN + (MPN or SKU) + brand + model + size_canonical + size_compact."""
    bc = str(row.get("barcode", "")).strip()
    if not gtin_check_digit_valid(bc):
        return False, "barcode missing or fails GTIN check"
    mpn = str(row.get("manufacturer_part_number", "")).strip()
    sku = str(row.get("retailer_sku", "")).strip()
    if not (mpn or sku):
        return False, "missing both MPN and SKU"
    for fld in ("brand", "model", "size_canonical", "size_compact"):
        if not str(row.get(fld, "")).strip():
            return False, f"missing {fld}"
    return True, ""

if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Windows cp1252 safety
    except Exception:
        pass
    print("=== validate.py self-test ===")
    # Size tests
    cases = [
        ('225/65R17',   '225/65R17',   '2256517'),
        ('P225/65R17',  'P225/65R17',  '2256517'),
        ('LT275/70R18', 'LT275/70R18', '2757018'),
        ('33x12.50R20', '33x12.50R20', '33125020'),
        ('295/75R22.5', '295/75R22.5', '29575225'),
        ('11R22.5',     '11R22.5',     '11225'),
    ]
    all_ok = True
    for raw, ec, ek in cases:
        c, k = normalize_size(raw)
        ok = c==ec and k==ek
        if not ok: all_ok = False
        print(f"  size {raw:20s} -> ({c},{k}) {'✓' if ok else f'✗ expected ({ec},{ek})'}")

    # GTIN tests
    gtin_cases = [('036000291452',True),('012345678905',True),('000000000000',False),('1234',False),('4006381333931',True)]
    for bc, exp in gtin_cases:
        r = gtin_check_digit_valid(bc)
        ok = r==exp
        if not ok: all_ok = False
        print(f"  gtin {bc}: {r} {'✓' if ok else f'✗ expected {exp}'}")

    print(f"\n{'ALL TESTS PASSED' if all_ok else 'SOME TESTS FAILED'}")
