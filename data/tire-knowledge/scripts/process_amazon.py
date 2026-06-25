#!/usr/bin/env python3
"""
Process raw Amazon product-page extracts into validated tire corpus rows.
Usage: echo '<json>' | python3 process_amazon.py
Or:    python3 process_amazon.py '<json>'
"""
import json, sys, re, csv, os
from datetime import datetime, timezone
sys.path.insert(0, '/sessions/adoring-stoic-cannon/mnt/inventory/data/tire-knowledge/scripts')
from validate import (gtin_check_digit_valid, barcode_type_label, normalize_size,
                      normalize_brand, normalize_model, make_identity_key, make_uid,
                      completeness_score, missing_fields_str, now_iso, FLAT_COLS)

BASE = '/sessions/adoring-stoic-cannon/mnt/inventory/data/tire-knowledge'
RUN_ID = 'run_20260622_001'

# ── Tire title parser ─────────────────────────────────────────────────────────
# Matches: "Brand Model ... SIZE LOAD/LOADSR LOADRANGE ..."
TITLE_SIZE_RE = re.compile(
    r'((?:LT|P|ST|C|T)?'
    r'(?:\d{3}(?:\.\d)?/\d{2}(?:\.\d)?R\d{2}(?:\.\d)?'
    r'|\d{2}x\d{2}(?:\.\d+)?R\d{2}'
    r'|\d{1,3}(?:/\d{2,3})?R\d{2}(?:\.\d)?))'
    r'(?:\s*[-/]?\s*(\d{2,3}(?:/\d{2,3})?)\s*([A-Z]{1,2}))?',
    re.IGNORECASE
)
LOAD_SPEED_RE = re.compile(r'(\d{2,3}(?:[/]\d{2,3})?)\s*([A-Z]{1,2})\b')

KNOWN_BRANDS = {
    'falken','goodyear','michelin','bridgestone','firestone','continental',
    'general','dunlop','kelly','uniroyal','pirelli','toyo','nitto','yokohama',
    'cooper','bfgoodrich','hankook','kumho','nexen','sailun','ironman',
    'hercules','mastercraft','sumitomo','laufenn','blackhawk','westlake',
    'milestar','goodride','gt radial','linglong','prinx','fortune','delinte',
    'sentury','ohtsu','nokian','kenda','maxxis','carlisle','radar','roadx',
    'accelera','atturo','atlas','armstrong','venom power','travelstar',
    'cosmo','evoluxx','roundrule','fullway','gladiator','lexani','advanta',
    'sentury','crosswind','gt radial','otomaster','landsail','leao','haida',
    'arisun','thunderer','pantera','nankang','starfire','patriot','zenna',
    'eldorado','eldorado','cooper','cst','epsilon','antares','amp','achilles',
    'arroyo','interco','terra king','trail guide','wild trail','kanati',
    'nitro power','landspider','finalist','fury','bkt','galaxy','titan',
    'harvest king','alliance','mitas','superguard','suntek','cargo max',
    'transeagle','nebula','provider','blackarrow','tourador','loadstar',
    'duraturn','zeetex','royal black','comforser','obor','kapsen',
}

def extract_brand_from_title(title: str) -> str:
    """Try to detect brand from start of title."""
    t = title.strip()
    # Try 2-word brands first
    words = t.split()
    if len(words) >= 2:
        two = (words[0] + ' ' + words[1]).lower()
        if two in KNOWN_BRANDS:
            return two
    if words:
        one = words[0].lower()
        if one in KNOWN_BRANDS:
            return one
    return words[0].lower() if words else ''

def extract_model_from_title(title: str, brand: str) -> str:
    """Extract model name — everything between brand and size."""
    t = title.strip()
    # Remove brand from start
    brand_words = len(brand.split())
    remaining = ' '.join(t.split()[brand_words:])
    # Find where size starts
    m = TITLE_SIZE_RE.search(remaining)
    if m:
        model_part = remaining[:m.start()].strip()
        # Clean up
        model_part = re.sub(r'\s+', ' ', model_part).strip()
        # Remove trailing qualifiers like "All Terrain", "All Season", "Radial"
        model_part = re.sub(r'\s+(All.Terrain|All.Season|All.Weather|Radial|Tire|Light.Truck.*|Passenger.*|Highway.*|Mud.Terrain.*)$', '', model_part, flags=re.IGNORECASE).strip()
        return model_part if model_part else remaining.split()[0] if remaining else ''
    return ''

def parse_product(raw: dict) -> dict | None:
    """Convert raw Amazon page extract into a structured tire row. Returns None if unusable."""
    title = raw.get('title', '').strip()
    if not title:
        return None

    # Must contain a tire size
    size_match = TITLE_SIZE_RE.search(title)
    if not size_match:
        return None

    raw_size = size_match.group(1)
    size_canonical, size_compact = normalize_size(raw_size)
    if not size_canonical or not size_compact:
        return None

    # Brand
    brand_raw = raw.get('brand', '') or extract_brand_from_title(title)
    brand = normalize_brand(brand_raw)
    if not brand:
        return None

    # Model
    model_raw = raw.get('model_name', '') or extract_model_from_title(title, brand_raw or brand)
    model = normalize_model(model_raw) if model_raw else ''
    if not model:
        # Fallback: use 2nd word in title (after brand)
        title_words = title.split()
        bw = len((brand_raw or brand).split())
        model = normalize_model(title_words[bw]) if len(title_words) > bw else ''
    if not model:
        return None

    # Load index + speed rating (from details table or title)
    details = raw.get('details', {})
    li_raw = details.get('Load Index', '') or details.get('Load index', '')
    sr_raw = details.get('Speed Rating', '') or details.get('Speed rating', '')

    # Try parsing from title if not in details
    if not li_raw or not sr_raw:
        # Look for pattern like "125/122S" or "104T" in title after size
        after_size = title[size_match.end():]
        ls_m = LOAD_SPEED_RE.search(after_size)
        if ls_m:
            if not li_raw: li_raw = ls_m.group(1)
            if not sr_raw: sr_raw = ls_m.group(2)

    load_index = li_raw.strip()
    speed_rating = sr_raw.strip().upper() if sr_raw else ''

    # Tire type / season
    tire_type = details.get('Tire Type', details.get('Tire type', details.get('Road Surface Type', '')))
    season    = details.get('Season', details.get('Tread Type', ''))

    # UPC
    upc = raw.get('upc', '').strip()
    # Clean: remove spaces, dashes
    upc = re.sub(r'[^0-9]', '', upc)

    # Validate UPC
    bc_type = ''
    if upc:
        bc_type = barcode_type_label(upc)
        if bc_type not in ('upc', 'ean', 'gtin'):
            upc = ''
            bc_type = ''
        elif not gtin_check_digit_valid(upc):
            upc = ''
            bc_type = ''

    # MPN
    mpn = details.get('ASIN', raw.get('asin', '')).strip()
    # Also check for Item model number
    mpn_alt = details.get('Item model number', details.get('Part Number', '')).strip()
    if mpn_alt and mpn_alt != mpn:
        mpn = mpn_alt  # prefer actual MPN over ASIN

    source_url = raw.get('source_url', '')
    if not source_url and raw.get('asin'):
        source_url = f"https://www.amazon.com/dp/{raw['asin']}"

    # Current status — Amazon listings are active_retail unless explicitly unavailable
    status_note = raw.get('availability', '').lower()
    if any(w in status_note for w in ['discontinued','unavailable','out of production']):
        current_status = 'discontinued'
    else:
        current_status = 'active_retail'

    # Evidence
    evidence = 'verified_1src_strong' if upc else 'verified_1src_weak'
    usable   = 'auto_count_candidate' if upc else 'part_number_lookup'

    uid = make_uid(brand, model, size_canonical, load_index, speed_rating, mpn)
    identity_key = make_identity_key(brand, model, size_canonical, load_index, speed_rating, mpn)

    row = {
        'canonical_product_uid': uid,
        'brand': brand,
        'model': model,
        'size_canonical': size_canonical,
        'size_compact': size_compact,
        'load_index': load_index,
        'speed_rating': speed_rating,
        'tire_type': tire_type,
        'season': season,
        'barcode': upc,
        'barcode_type': bc_type,
        'manufacturer_part_number': mpn,
        'source_url': source_url,
        'evidence_level': evidence,
        'usable_for': usable,
        'current_status': current_status,
        'missing_fields': '',
        'field_completeness_score': 0.0,
        'harvested_at': now_iso(),
        'run_id': RUN_ID,
        '_identity_key': identity_key,
        '_title': title,
    }
    row['missing_fields'] = missing_fields_str(row)
    row['field_completeness_score'] = completeness_score(row)
    return row

def append_to_corpus(rows: list[dict], seen_barcodes: set, seen_keys: set):
    """Append valid rows to tire_corpus_flat.csv. Returns (trusted, backlog, rejected) counts."""
    corpus_path = f'{BASE}/tire_corpus_flat.csv'
    backlog_path = f'{BASE}/tire_enrichment_backlog.csv'
    rejected_path = f'{BASE}/rejected_rows.csv'

    trusted, backlog_count, rejected = 0, 0, 0

    with open(corpus_path, 'a', newline='', encoding='utf-8') as cf, \
         open(backlog_path, 'a', newline='', encoding='utf-8') as bf, \
         open(rejected_path, 'a', newline='', encoding='utf-8') as rf:

        cw = csv.DictWriter(cf, fieldnames=FLAT_COLS, extrasaction='ignore')
        bw_cols = ['canonical_product_uid','brand','model','size_canonical','size_compact',
                   'barcode','barcode_type','manufacturer_part_number','source_url',
                   'missing_fields','reason','harvested_at','run_id']
        bw = csv.DictWriter(bf, fieldnames=bw_cols, extrasaction='ignore')
        rw_cols = ['raw_brand','raw_model','raw_size','raw_barcode','raw_mpn','source_url','reject_reason','harvested_at','run_id']
        rw = csv.DictWriter(rf, fieldnames=rw_cols, extrasaction='ignore')

        for row in rows:
            if row is None:
                rejected += 1
                continue

            ik = row.get('_identity_key', '')
            bc = row.get('barcode', '')

            # Dedupe check
            if ik and ik in seen_keys:
                rejected += 1
                continue
            if bc and bc in seen_barcodes:
                rejected += 1
                continue

            # Route
            if row.get('current_status') == 'discontinued':
                rw.writerow({'raw_brand': row['brand'], 'raw_model': row['model'],
                             'raw_size': row['size_canonical'], 'raw_barcode': bc,
                             'raw_mpn': row['manufacturer_part_number'],
                             'source_url': row['source_url'],
                             'reject_reason': 'discontinued',
                             'harvested_at': row['harvested_at'], 'run_id': RUN_ID})
                rejected += 1
                continue

            if bc and row.get('barcode_type') in ('upc','ean','gtin'):
                # Trusted barcode row
                cw.writerow(row)
                seen_barcodes.add(bc)
                if ik: seen_keys.add(ik)
                trusted += 1
            elif row.get('manufacturer_part_number'):
                # Backlog — has MPN but no barcode
                brow = {k: row.get(k,'') for k in bw_cols}
                brow['reason'] = 'no_barcode_has_mpn'
                bw.writerow(brow)
                if ik: seen_keys.add(ik)
                backlog_count += 1
            else:
                # Reject — no barcode, no MPN
                rw.writerow({'raw_brand': row['brand'], 'raw_model': row['model'],
                             'raw_size': row['size_canonical'], 'raw_barcode': '',
                             'raw_mpn': '', 'source_url': row['source_url'],
                             'reject_reason': 'no_barcode_no_mpn',
                             'harvested_at': row['harvested_at'], 'run_id': RUN_ID})
                rejected += 1

    return trusted, backlog_count, rejected

if __name__ == '__main__':
    # Test parser
    test = {
        "asin": "B0CR68NPLC",
        "title": "Falken Wildpeak A/T4W All Terrain LT275/70R18 125/122S E Light Truck Tire",
        "brand": "Falken",
        "upc": "848983026514",
        "details": {"Load Index": "125", "Speed Rating": "S", "Tire Type": "All Terrain"},
        "availability": "In Stock"
    }
    row = parse_product(test)
    print("Test parse:", json.dumps({k:v for k,v in row.items() if not k.startswith('_')}, indent=2))
    print("GTIN valid:", gtin_check_digit_valid("848983026514"))
