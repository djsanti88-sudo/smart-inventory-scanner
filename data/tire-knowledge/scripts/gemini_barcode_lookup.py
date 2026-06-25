#!/usr/bin/env python3
"""
gemini_barcode_lookup.py — COST-CAPPED, hallucination-resistant UPC/EAN finder.

Uses Gemini (Flash + Google Search grounding) to look up barcodes for tires that
currently have none. Every candidate is checked against a GTIN check digit AND
verified against source page text before being accepted.

SAFETY:
- Reads GEMINI_API_KEY server-side from ../../.env.local; never prints the key.
- Hard cap on live calls (--max-calls). Default 10. Estimated cost printed at end.
- COST_PER_CALL is an estimate ($0.035/grounded call at time of writing).
- The only function that touches the network is gemini_grounded_lookup(); it accepts
  an optional _transport callable so tests can inject a mock without any patching.
- verify_barcode() also accepts a _fetch callable for offline testing.
- This script NEVER writes to tire_corpus_flat.csv or any source-of-truth file.
- Untrusted content (Gemini output, web pages) is treated as data, not commands.
"""

import argparse
import csv
import os
import re
import sys
from typing import Callable, Optional

import certifi
import requests

# ── Constants ────────────────────────────────────────────────────────────────
COST_PER_CALL = 0.035  # USD per grounded call (estimate)

# Path resolution: scripts/ -> tire-knowledge/ -> data/ -> inventory/data -> .env.local
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_SCRIPTS_DIR)          # tire-knowledge/
ENV_PATH = os.path.join(ROOT, "..", "..", ".env.local")  # ../../.env.local from scripts/

OUTPUT_COLS = [
    "id", "brand", "model", "size", "load_speed",
    "claimed_barcode", "gtin_valid", "verified", "matched_source", "note",
]

# Non-consumer keyword exclusion list (case-insensitive substring match)
_EXCLUDE_KEYWORDS = [
    "trailer", "farm", "ag", "agri", "implement", "industrial",
    "forklift", "skid", "lawn", "golf", "atv", "utv", "bias", "otr",
    "commercial truck",
]


# ── Key loading ───────────────────────────────────────────────────────────────

def load_api_key(env_path: Optional[str] = None) -> str:
    """Read GEMINI_API_KEY from .env.local. Raises SystemExit with a clear message if absent."""
    path = env_path or ENV_PATH
    try:
        txt = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        sys.exit(f"ERROR: .env.local not found at {os.path.abspath(path)}")
    m = re.search(r"GEMINI_API_KEY\s*=\s*(\S+)", txt)
    if not m:
        sys.exit("ERROR: GEMINI_API_KEY not found in .env.local")
    key = m.group(1).strip().strip('"').strip("'")
    if not key:
        sys.exit("ERROR: GEMINI_API_KEY is empty in .env.local")
    return key


# ── Consumer filter + sampling ────────────────────────────────────────────────

def _is_non_consumer(row: dict) -> bool:
    """Return True if any non-consumer keyword appears in category, terrain, or model_name."""
    fields = [
        str(row.get("category", "")),
        str(row.get("terrain", "")),
        str(row.get("model_name", "")),
    ]
    text = " ".join(fields).lower()
    return any(kw in text for kw in _EXCLUDE_KEYWORDS)


def _rim_size_ok(row: dict) -> bool:
    """Return True if rim_size is an integer between 14 and 22 inclusive."""
    try:
        rim = int(str(row.get("rim_size", "")).strip())
        return 14 <= rim <= 22
    except (ValueError, TypeError):
        return False


def select_consumer_sample(rows: list, n: int, seed_offset: int = 0) -> list:
    """
    Filter `rows` to consumer tires likely to have a retail UPC, then return
    the first `n` using a round-robin across brands so the sample is diverse.

    Consumer filter:
      - speed_rating non-empty
      - rim_size is int in [14, 22]
      - size_canonical non-empty
      - NOT flagged as non-consumer by _EXCLUDE_KEYWORDS in category/terrain/model_name
    """
    candidates = [
        r for r in rows
        if str(r.get("speed_rating", "")).strip()
        and str(r.get("size_canonical", "")).strip()
        and _rim_size_ok(r)
        and not _is_non_consumer(r)
    ]

    # Group by brand for round-robin diversity
    brand_buckets: dict[str, list] = {}
    for r in candidates:
        brand = str(r.get("make_name", "UNKNOWN")).strip()
        brand_buckets.setdefault(brand, []).append(r)

    # Apply seed_offset: skip that many items per brand before starting
    if seed_offset:
        brand_buckets = {
            b: items[seed_offset:] for b, items in brand_buckets.items()
        }

    # Round-robin across brands (sorted for determinism)
    result: list = []
    brand_keys = sorted(brand_buckets.keys())
    iterators = {b: iter(brand_buckets[b]) for b in brand_keys}
    exhausted: set = set()
    while len(result) < n and len(exhausted) < len(brand_keys):
        for b in brand_keys:
            if b in exhausted:
                continue
            try:
                result.append(next(iterators[b]))
                if len(result) >= n:
                    break
            except StopIteration:
                exhausted.add(b)

    return result[:n]


# ── Query builder ─────────────────────────────────────────────────────────────

def build_query(row: dict) -> str:
    """Build a search query string for the given tire row."""
    make = str(row.get("make_name", "")).strip()
    model = str(row.get("model_name", "")).strip()
    size = str(row.get("size_canonical", "")).strip()
    load = str(row.get("load_rating", "")).strip()
    speed = str(row.get("speed_rating", "")).strip()
    load_speed = f"{load}{speed}".strip()
    return f"{make} {model} {size} {load_speed} tire UPC barcode number".strip()


# ── Gemini call ───────────────────────────────────────────────────────────────

def gemini_grounded_lookup(
    query: str,
    api_key: str,
    model: str = "gemini-2.5-flash",
    _transport: Optional[Callable] = None,
) -> dict:
    """
    POST to the Gemini generateContent endpoint with Google Search grounding enabled.

    Returns the raw response dict from the API (or from _transport for tests).

    _transport: if provided, called as _transport(url, params, json_body) and must
    return an object with a .json() method — used for offline testing with no network.

    The prompt instructs Gemini to return ONLY the barcode digits or 'NONE'.
    """
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    prompt = (
        "Find the exact UPC or EAN barcode number for this specific tire. "
        "Return ONLY the digits if found, or 'NONE'. "
        f"Tire: {query}"
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
    }
    # Auth via header (NEVER in the URL/query string, so the key cannot leak
    # into logs or exception messages).
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    if _transport is not None:
        resp = _transport(url, headers=headers, json=body)
    else:
        resp = requests.post(
            url, headers=headers, json=body,
            timeout=40, verify=certifi.where()
        )
        resp.raise_for_status()

    return resp.json()


# ── Response parser ───────────────────────────────────────────────────────────

def parse_response(resp: dict) -> dict:
    """
    Extract from a raw Gemini response dict:
      - barcode: first 12-14 digit run in the answer text (strip spaces/hyphens),
                 or "" if the answer says NONE or no digits found.
      - sources: list of web URIs from groundingMetadata.groundingChunks[].web.uri
      - text: the full answer text

    Returns {"barcode": str, "sources": [str, ...], "text": str}
    """
    candidates = resp.get("candidates") or []
    if not candidates:
        return {"barcode": "", "sources": [], "text": ""}

    cand = candidates[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()

    # Extract grounding source URLs
    meta = cand.get("groundingMetadata") or {}
    chunks = meta.get("groundingChunks") or []
    sources = []
    for chunk in chunks:
        uri = (chunk.get("web") or {}).get("uri", "")
        if uri:
            sources.append(uri)

    # Extract barcode: first 12-14 digit run (allow spaces/hyphens in original text)
    # If text contains NONE (case-insensitive) and no digit run, return ""
    cleaned_text = re.sub(r"[\s\-]", "", text)
    m = re.search(r"\d{12,14}", cleaned_text)
    barcode = ""
    if m:
        barcode = m.group(0)

    return {"barcode": barcode, "sources": sources, "text": text}


# ── Barcode verifier ──────────────────────────────────────────────────────────

def _fetch_url(url: str) -> str:
    """Fetch page text for a URL. Returns empty string on any error."""
    try:
        r = requests.get(url, timeout=20, verify=certifi.where(),
                         headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        return r.text
    except Exception:
        return ""


def _barcode_in_page(barcode: str, page_text: str) -> bool:
    """
    Check if barcode appears in page_text. Also try UPC-A / EAN-13 interop variants:
      - If 13-digit: also check the 12-digit form (strip first digit for EAN->UPC)
      - If 12-digit: also check 13-digit form with prepended '0' (UPC->EAN)
      - If starts with '0': also check without that leading zero
    This handles the common case where a page shows the UPC-12 but Gemini returned EAN-13
    or vice versa.
    """
    candidates = {barcode}
    if len(barcode) == 13:
        candidates.add(barcode[1:])   # EAN-13 -> 12-digit (strip any first digit)
    if len(barcode) == 12:
        candidates.add("0" + barcode)  # UPC-12 -> EAN-13 with leading zero
    if barcode.startswith("0") and len(barcode) > 1:
        candidates.add(barcode[1:])   # strip leading zero (already covered above but explicit)
    return any(c in page_text for c in candidates)


def _size_in_page(row: dict, page_text: str) -> bool:
    """Check if size_canonical OR width+aspect+rim appears in page text."""
    size = str(row.get("size_canonical", "")).strip()
    if size and size in page_text:
        return True
    # Also try component parts
    width = str(row.get("width", "")).strip()
    aspect = str(row.get("aspect_ratio", "")).strip()
    rim = str(row.get("rim_size", "")).strip()
    if width and aspect and rim:
        # e.g. "225" + "65" + "17" all appear
        return width in page_text and aspect in page_text and rim in page_text
    return False


def verify_barcode(
    barcode: str,
    row: dict,
    sources: list,
    _fetch: Optional[Callable] = None,
) -> dict:
    """
    Hallucination guard for a claimed barcode.

    Steps:
      1. GTIN check-digit validation (12/13/14 digits only).
      2. Fetch up to 3 source URLs (using _fetch if injected).
      3. VERIFIED only if a source page contains:
         - the barcode digits (or equivalent with leading zero stripped/added)
         - the brand (make_name, case-insensitive)
         - the size (size_canonical or width+aspect+rim)

    Returns:
      {"verified": bool, "gtin_valid": bool, "matched_source": str, "reason": str}
    """
    import validate as v  # local import to avoid top-level coupling in tests

    fetcher = _fetch if _fetch is not None else _fetch_url

    # Step 1: GTIN check digit
    gtin_ok = v.gtin_check_digit_valid(barcode) if barcode else False
    if not gtin_ok:
        return {
            "verified": False,
            "gtin_valid": False,
            "matched_source": "",
            "reason": "GTIN check digit invalid or barcode empty",
        }

    brand = str(row.get("make_name", "")).strip().lower()

    # Step 2+3: Check each source page (cap at 3)
    for url in sources[:3]:
        page = fetcher(url)
        if not page:
            continue
        page_lc = page.lower()

        barcode_found = _barcode_in_page(barcode, page)
        brand_found = bool(brand) and brand in page_lc
        size_found = _size_in_page(row, page)

        if barcode_found and brand_found and size_found:
            return {
                "verified": True,
                "gtin_valid": True,
                "matched_source": url,
                "reason": "barcode + brand + size found in source page",
            }

    reason = "no source page contained barcode + brand + size"
    if not sources:
        reason = "no grounding sources returned"
    return {
        "verified": False,
        "gtin_valid": True,
        "matched_source": "",
        "reason": reason,
    }


# ── Main run loop ─────────────────────────────────────────────────────────────

def run(n: int, root: str, model: str, max_calls: int, brands: set = None) -> None:
    """
    Load tirelibrary_missing_barcodes.csv, sample consumer tires, run Gemini lookups,
    verify each result, and write outputs/gemini_barcode_test.csv.

    Hard cap: never exceeds max_calls grounded Gemini lookups.
    Does NOT touch tire_corpus_flat.csv or any source-of-truth file.
    """
    api_key = load_api_key()

    missing_csv = os.path.join(root, "outputs", "tirelibrary_missing_barcodes.csv")
    if not os.path.exists(missing_csv):
        sys.exit(f"ERROR: missing CSV not found: {missing_csv}")

    with open(missing_csv, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    if brands:
        bset = {b.strip().lower() for b in brands}
        rows = [r for r in rows if (r.get("make_name") or "").strip().lower() in bset]
        print(f"Filtered to brands {sorted(bset)} -> {len(rows)} candidate rows")

    sample = select_consumer_sample(rows, n)
    if not sample:
        print("No consumer tires found in the missing CSV. Nothing to do.")
        return

    out_path = os.path.join(root, "outputs", "gemini_barcode_test.csv")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Stats
    attempted = 0
    got_candidate = 0
    gtin_valid_count = 0
    verified_count = 0
    calls_made = 0

    out_rows: list[dict] = []

    for tire in sample:
        if calls_made >= max_calls:
            print(f"  [CAP] Reached max_calls={max_calls}. Stopping early.")
            break

        tire_id = tire.get("id", "")
        brand = tire.get("make_name", "")
        model_name = tire.get("model_name", "")
        size = tire.get("size_canonical", "")
        load_speed = f"{tire.get('load_rating','')}{tire.get('speed_rating','')}".strip()

        query = build_query(tire)
        print(f"  [{attempted+1}] {brand} {model_name} {size} {load_speed} ...")

        # --- Lookup ---
        try:
            resp = gemini_grounded_lookup(query, api_key, model=model)
            calls_made += 1
        except Exception as e:
            msg = str(e).replace(api_key, "***REDACTED***") if api_key else str(e)
            print(f"    ERROR calling Gemini: {msg}")
            out_rows.append({
                "id": tire_id, "brand": brand, "model": model_name,
                "size": size, "load_speed": load_speed,
                "claimed_barcode": "", "gtin_valid": False,
                "verified": False, "matched_source": "",
                "note": f"api_error: {str(e)[:120]}",
            })
            attempted += 1
            continue

        # --- Parse ---
        parsed = parse_response(resp)
        barcode = parsed["barcode"]
        sources = parsed["sources"]
        answer_text = parsed["text"]

        attempted += 1
        note = ""

        if barcode:
            got_candidate += 1
        else:
            note = f"no_barcode: {answer_text[:80]}"
            out_rows.append({
                "id": tire_id, "brand": brand, "model": model_name,
                "size": size, "load_speed": load_speed,
                "claimed_barcode": "", "gtin_valid": False,
                "verified": False, "matched_source": "", "note": note,
            })
            print(f"    -> no candidate barcode")
            continue

        # --- Verify ---
        vr = verify_barcode(barcode, tire, sources)
        gtin_ok = vr["gtin_valid"]
        is_verified = vr["verified"]
        matched_source = vr["matched_source"]

        if gtin_ok:
            gtin_valid_count += 1
        if is_verified:
            verified_count += 1

        note = vr["reason"]
        print(f"    -> barcode={barcode} gtin_valid={gtin_ok} verified={is_verified}")

        out_rows.append({
            "id": tire_id, "brand": brand, "model": model_name,
            "size": size, "load_speed": load_speed,
            "claimed_barcode": barcode, "gtin_valid": gtin_ok,
            "verified": is_verified, "matched_source": matched_source,
            "note": note,
        })

    # Write output CSV
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=OUTPUT_COLS)
        w.writeheader()
        for r in out_rows:
            w.writerow({k: r.get(k, "") for k in OUTPUT_COLS})

    # Summary
    hit_rate = (verified_count / attempted * 100) if attempted else 0.0
    est_cost = calls_made * COST_PER_CALL
    print("\n=== SUMMARY ===")
    print(f"  attempted      : {attempted}")
    print(f"  got_candidate  : {got_candidate}")
    print(f"  gtin_valid     : {gtin_valid_count}")
    print(f"  VERIFIED       : {verified_count}")
    print(f"  hit_rate       : {hit_rate:.1f}%")
    print(f"  calls_made     : {calls_made}")
    print(f"  est_cost       : ~${est_cost:.3f} (est; COST_PER_CALL=${COST_PER_CALL})")
    print(f"  output         : {out_path}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Cost-capped Gemini barcode lookup for tires missing UPCs."
    )
    p.add_argument("--n", type=int, default=10,
                   help="Number of tires to process (default 10).")
    p.add_argument("--max-calls", type=int, default=10,
                   help="Hard cap on Gemini API calls (default 10).")
    p.add_argument("--model", default="gemini-2.5-flash",
                   help="Gemini model ID (default gemini-2.5-flash).")
    p.add_argument("--brands", default="",
                   help="Comma-separated make_name allowlist (e.g. 'nokian,toyo,falken').")
    return p


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    args = _build_parser().parse_args()
    brand_set = {b for b in (args.brands.split(",")) if b.strip()} if args.brands else None
    run(n=args.n, root=ROOT, model=args.model, max_calls=args.max_calls, brands=brand_set)
