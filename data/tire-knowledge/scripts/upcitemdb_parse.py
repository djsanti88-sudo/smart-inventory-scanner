#!/usr/bin/env python3
"""
upcitemdb_parse.py — Parse a saved upcitemdb.com brand page (HTML) into tire identity dicts.
No network calls. Parses the saved fixture only.
"""

import re
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import validate

# ── HTML extraction ────────────────────────────────────────────────────────────

_RIMAGE_RE = re.compile(
    r'<div class="rImage"><a href="[^"]*?/upc/(\d{12,14})"[^>]*>[^<]*</a><p>(.*?)</p>',
    re.DOTALL,
)


def extract_rows(html: str) -> list:
    """Return list of (upc_str, name_str) from rImage divs. Dedup by UPC."""
    seen = {}
    for m in _RIMAGE_RE.finditer(html):
        upc = m.group(1).strip()
        name = m.group(2).strip()
        if upc not in seen:
            seen[upc] = name
    return list(seen.items())


# ── Size token regex ───────────────────────────────────────────────────────────
# Matches standard (P/LT/ST/T prefix optional), ZR variants, and floatation (LT prefix optional).
# Group 0 = full token.
_SIZE_TOKEN_RE = re.compile(
    r'(?:'
    # floatation: optional LT + digits x digits.R digits (e.g. LT37X13.50R20, 33x12.50R20)
    r'(?:LT)?\d{2}[xX]\d{1,2}(?:\.\d+)?[Rr]\d{2}'
    r'|'
    # standard/ZR: optional prefix + width / aspect [Z]R rim
    r'(?:P|LT|ST|T|C)?'
    r'\d{2,3}(?:\.\d+)?'
    r'[/xX]'
    r'\d{2,3}(?:\.\d+)?'
    r'Z?[Rr]'
    r'\d{2}(?:\.\d)?'
    r')',
    re.IGNORECASE,
)

# Load+speed token immediately after the size (e.g. "110T", "125/121M", "127Q", "124/121S")
_LOAD_SPEED_RE = re.compile(
    r'^(\d{2,3}(?:/\d{2,3})?)\s*([A-Z]{1,2})\b'
)

# MPN pattern: letter(s) + digits + optional letter  OR  pure digits 3-5
_MPN_RE = re.compile(r'\b([A-Z]{1,5}\d{2,5}[A-Z]?|\d{3,5})\b')

# Category at end of name
_CATEGORY_RE = re.compile(
    r'(Light Truck|Passenger|Trailer|ATV|UTV|Farm|Commercial)\s+Tire$',
    re.IGNORECASE,
)

# Tire type keywords (explicit, scan whole name)
_TYPE_KEYWORDS = [
    ('all_terrain',  re.compile(r'\bAll[\s\-]Terrain\b', re.IGNORECASE)),
    ('mud_terrain',  re.compile(r'\bMud[\s\-]Terrain\b', re.IGNORECASE)),
    ('highway',      re.compile(r'\bHighway(?:[\s\-]Terrain)?\b', re.IGNORECASE)),
    ('touring',      re.compile(r'\bTouring\b', re.IGNORECASE)),
]

_CATEGORY_TYPE_MAP = {
    'light truck': 'light_truck',
    'passenger':   'passenger',
    'trailer':     'trailer',
}

# Season keywords
_SEASON_KEYWORDS = [
    ('all_season',   re.compile(r'\bAll[\s\-]Season\b', re.IGNORECASE)),
    ('all_weather',  re.compile(r'\bAll[\s\-]Weather\b', re.IGNORECASE)),
    ('summer',       re.compile(r'\bSummer\b', re.IGNORECASE)),
    ('winter',       re.compile(r'\bWinter\b', re.IGNORECASE)),
]

# Words to strip from model text
_MODEL_STRIP_RE = re.compile(
    r'\b(?:'
    r'All[\s\-]Terrain|Mud[\s\-]Terrain|Highway(?:[\s\-]Terrain)?|Touring|'
    r'All[\s\-]Season|All[\s\-]Weather|Summer|Winter|'
    r'Light\s+Truck\s+Tire|Passenger\s+Tire|Trailer\s+Tire|'
    r'Light\s+Truck|Passenger|Trailer|Tire|'
    r'[A-Z]\s+(?:Light\s+Truck|Passenger|Trailer)\s+Tire|'
    r'XL|E\b|C\b|D\b'
    r')\b',
    re.IGNORECASE,
)


def _normalize_zr(size_token: str) -> str:
    """Strip Z from ZR to make it R (validate.normalize_size does not handle ZR)."""
    return re.sub(r'ZR', 'R', size_token, flags=re.IGNORECASE)


def parse_name(name: str) -> dict:
    """
    Best-effort parse a tire product name string into identity fields.
    Returns {} if no valid tire size can be extracted (caller skips the row).
    """
    # 1. Find size token
    size_m = _SIZE_TOKEN_RE.search(name)
    if not size_m:
        return {}

    raw_size = size_m.group(0)
    normalized_size = _normalize_zr(raw_size)

    size_canonical, size_compact = validate.normalize_size(normalized_size)
    if size_canonical is None:
        return {}

    size_start = size_m.start()
    size_end = size_m.end()

    # 2. Load index + speed rating: text immediately after size token
    after_size = name[size_end:].strip()
    ls_m = _LOAD_SPEED_RE.match(after_size)
    load_index = ''
    speed_rating = ''
    if ls_m:
        load_index = ls_m.group(1)
        speed_rating = ls_m.group(2)

    # 3. Tire type from explicit keywords in full name
    tire_type = ''
    for label, pat in _TYPE_KEYWORDS:
        if pat.search(name):
            tire_type = label
            break

    # If no explicit type keyword, fall back to category
    if not tire_type:
        cat_m = _CATEGORY_RE.search(name)
        if cat_m:
            cat_key = cat_m.group(1).lower()
            tire_type = _CATEGORY_TYPE_MAP.get(cat_key, '')

    # 4. Season
    season = ''
    for label, pat in _SEASON_KEYWORDS:
        if pat.search(name):
            season = label
            break

    # 5. Brand: first word(s) before the model text.
    # We use the first word as brand (caller overrides with canonical brand).
    before_size = name[:size_start].strip()
    tokens_before = before_size.split()
    brand = tokens_before[0] if tokens_before else ''

    # 6. Model: text between brand and size, stripped of type/season/category words
    if len(tokens_before) > 1:
        model_raw = ' '.join(tokens_before[1:])
    else:
        model_raw = ''
    model_clean = _MODEL_STRIP_RE.sub(' ', model_raw).strip()
    model_clean = re.sub(r'\s{2,}', ' ', model_clean).strip()

    # 7. MPN: best-effort search within model_raw text
    mpn = ''
    for m in _MPN_RE.finditer(model_raw):
        candidate = m.group(1)
        # Prefer alphanumeric codes (letters+digits) over pure digits
        if re.search(r'[A-Z]', candidate, re.IGNORECASE) and re.search(r'\d', candidate):
            mpn = candidate
            break
    if not mpn:
        for m in _MPN_RE.finditer(model_raw):
            candidate = m.group(1)
            if candidate.isdigit() and len(candidate) >= 3:
                mpn = candidate
                break

    return {
        'brand':          brand,
        'model':          model_clean,
        'mpn':            mpn,
        'size_canonical': size_canonical,
        'size_compact':   size_compact,
        'load_index':     load_index,
        'speed_rating':   speed_rating,
        'tire_type':      tire_type,
        'season':         season,
    }


def parse_page(html: str, brand: str) -> list:
    """
    Parse a full upcitemdb brand page HTML.
    Returns list of identity dicts. Rows without a valid size are skipped.
    The brand argument overrides the parsed brand so we use the canonical brand queried.
    """
    results = []
    for upc, name in extract_rows(html):
        parsed = parse_name(name)
        if not parsed:
            continue  # no valid size — skip
        row = {
            'brand':         brand,
            'model':         parsed['model'],
            'mpn':           parsed['mpn'],
            'barcode':       upc,
            'size_canonical': parsed['size_canonical'],
            'size_compact':  parsed['size_compact'],
            'load_index':    parsed['load_index'],
            'speed_rating':  parsed['speed_rating'],
            'tire_type':     parsed['tire_type'],
            'season':        parsed['season'],
            'source_url':    '',
        }
        results.append(row)
    return results
