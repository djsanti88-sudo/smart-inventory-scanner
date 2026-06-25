#!/usr/bin/env python3
"""
harvest_tiresandwheels.py — Live harvest of product URLs from tiresandwheels.com model pages.

Strategy: URL-identity is trusted. Scrape model-page markdown (free, no per-product scrape),
regex-extract product URLs, parse barcode/mpn/sku/brand/model/size from the URL, write to corpus.

Credit budget: hard-stop when run_state['run_credits_spent'] >= max_credits.
"""

import csv
import os
import re
import sys
from datetime import datetime, timezone

# Make sure scripts/ folder is on the path when running as __main__
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import firecrawl_client as FC
from parse_tiresandwheels_url import parse_url
from write_outputs import write_rows
import ledger as L
from audit_corpus import audit

# ---------------------------------------------------------------------------
# Product URL extraction + enrichment parsing
# ---------------------------------------------------------------------------

_PRODUCT_URL_RE = re.compile(
    r'https://www\.tiresandwheels\.com/product/tire/[^\s\)\]>\'"]+',
    re.IGNORECASE,
)

# Matches a tire size like 255/55R18, LT265/70R17, P235/75R15
_TIRE_SIZE_RE = re.compile(r'^(?:[A-Z]{1,3})?\d{2,3}/\d{2,3}[A-Z]\d{2}$', re.IGNORECASE)

# Matches a load+speed token like 109W, 121/118S, 116Q, 107Y, 110W
_LOAD_SPEED_RE = re.compile(r'^\d{2,3}(/\d{2,3})?[A-Z]{1,2}$')

# Season keywords (lowercase)
_SEASON_TOKENS = {
    "summer": "summer",
    "all season": "all_season",
    "all-season": "all_season",
    "winter": "winter",
    "all weather": "all_weather",
    "all-weather": "all_weather",
}

# Known tire type words/phrases -> snake_case mapping (longest match first)
_TYPE_PHRASES = [
    ("highway terrain", "highway_terrain"),
    ("all terrain", "all_terrain"),
    ("mud terrain", "mud_terrain"),
    ("performance", "performance"),
    ("highway", "highway"),
    ("touring", "touring"),
    ("all-terrain", "all_terrain"),
    ("mud-terrain", "mud_terrain"),
]


def split_load_speed(token: str):
    """
    Split a load+speed token into (load_index, speed_rating).

    Examples:
        "109W"    -> ("109", "W")
        "121/118S"-> ("121/118", "S")
        "116Q"    -> ("116", "Q")
        "badtoken"-> ("", "")
    """
    token = token.strip()
    m = _LOAD_SPEED_RE.match(token)
    if not m:
        return ("", "")
    # Speed rating is trailing letters; load is everything before
    letter_match = re.search(r'[A-Za-z]+$', token)
    if not letter_match:
        return ("", "")
    speed = letter_match.group(0).upper()
    load = token[: letter_match.start()]
    return (load, speed)


def map_type_season(type_cell: str):
    """
    Parse a type cell like "Performance/Summer" or "All Terrain" into
    (tire_type, season).

    Returns ("", "") on empty/unrecognised input. Never raises.
    """
    try:
        if not type_cell or not type_cell.strip():
            return ("", "")

        # Split on "/" and examine each part
        parts = [p.strip() for p in type_cell.split("/")]

        season = ""
        type_parts = []

        for part in parts:
            lower = part.lower()
            # Check if this part is a season
            matched_season = ""
            for key, val in _SEASON_TOKENS.items():
                if lower == key:
                    matched_season = val
                    break

            if matched_season:
                season = matched_season
            else:
                # Try to map to a known tire type phrase
                matched_type = ""
                for phrase, mapped in _TYPE_PHRASES:
                    if phrase in lower:
                        matched_type = mapped
                        break
                if matched_type:
                    type_parts.append(matched_type)
                else:
                    # Fallback: convert to snake_case lowercase
                    snake = re.sub(r'[\s\-]+', '_', lower.strip())
                    if snake:
                        type_parts.append(snake)

        tire_type = "_".join(type_parts) if type_parts else ""
        return (tire_type, season)
    except Exception:
        return ("", "")


def extract_products(markdown: str) -> list:
    """
    Parse each table row in the markdown that contains a /product/tire/ URL.

    For each row, scan the pipe-delimited cells (without hard-coding column
    positions) and identify:
      - URL cell: contains /product/tire/
      - size cell: matches tire-size pattern
      - load+speed cell: matches load+speed pattern (digits, optional /digits, letters)
      - type cell: contains a season keyword or a known tire-type word

    Returns a list of dicts:
        {"url", "size", "load_index", "speed_rating", "tire_type", "season"}

    Deduplicates by URL. Missing fields default to "". Never raises per row.
    """
    seen_urls: set = set()
    results = []

    for line in markdown.splitlines():
        line = line.strip()
        # Must be a table row with a product URL
        if "/product/tire/" not in line:
            continue
        if not line.startswith("|"):
            continue

        # Split into cells, stripping leading/trailing whitespace
        cells = [c.strip() for c in line.split("|")]
        # cells[0] is empty (before first |), cells[-1] is empty (after last |)
        cells = [c for c in cells if c]

        url = ""
        size = ""
        load_speed_token = ""
        type_cell_raw = ""

        for cell in cells:
            # URL cell: extract URL from markdown link or bare URL
            if "/product/tire/" in cell and not url:
                m = _PRODUCT_URL_RE.search(cell)
                if m:
                    url = m.group(0).rstrip(".,;!?)")

            # Tire size cell
            if not size and _TIRE_SIZE_RE.match(cell):
                size = cell

            # Load+speed cell
            if not load_speed_token and _LOAD_SPEED_RE.match(cell):
                load_speed_token = cell

            # Type cell: contains a season or known type word
            if not type_cell_raw:
                lower_cell = cell.lower()
                is_type = any(kw in lower_cell for kw in (
                    "summer", "winter", "season", "weather",
                    "performance", "terrain", "highway", "touring",
                ))
                if is_type:
                    type_cell_raw = cell

        if not url:
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)

        load_index, speed_rating = split_load_speed(load_speed_token) if load_speed_token else ("", "")
        tire_type, season = map_type_season(type_cell_raw) if type_cell_raw else ("", "")

        results.append({
            "url": url,
            "size": size,
            "load_index": load_index,
            "speed_rating": speed_rating,
            "tire_type": tire_type,
            "season": season,
        })

    return results


def extract_product_urls(markdown: str) -> list:
    """
    Pure helper: regex-extract unique product/tire URLs from scraped markdown.
    No network calls. Returns a deduplicated list preserving first-seen order.

    This uses the original broad regex scan so it works in any markdown context
    (list items, prose, tables) — not just table rows.
    """
    seen = set()
    result = []
    for m in _PRODUCT_URL_RE.finditer(markdown):
        url = m.group(0).rstrip(".,;!?)")  # strip stray trailing punctuation
        if url not in seen:
            seen.add(url)
            result.append(url)
    return result


# ---------------------------------------------------------------------------
# Queue helpers
# ---------------------------------------------------------------------------

_QUEUE_COLS = ["model_url", "status", "added_at"]


def _load_queue(path: str) -> list:
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _save_queue(rows: list, path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=_QUEUE_COLS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in _QUEUE_COLS})


def _record_blocked(root: str, url: str, run_id: str, reason: str) -> None:
    path = os.path.join(root, "blocked_sources.csv")
    header = ["domain", "url_attempted", "block_type", "notes", "harvested_at", "run_id"]
    new = not os.path.exists(path) or os.path.getsize(path) == 0
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        if new:
            w.writeheader()
        w.writerow({
            "domain": "tiresandwheels.com",
            "url_attempted": url,
            "block_type": "scrape_error",
            "notes": reason[:200],
            "harvested_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "run_id": run_id,
        })


# ---------------------------------------------------------------------------
# Main harvest function
# ---------------------------------------------------------------------------

def harvest(max_credits: int, root: str, run_state: dict, run_id: str) -> dict:
    """
    Harvest product URLs from queued model pages.

    Args:
        max_credits: stop adding new scrapes when run_state['run_credits_spent'] >= this.
        root: harvester root directory.
        run_state: mutable dict with 'run_credits_spent' key (updated in place by firecrawl_client).
        run_id: string identifier for this run (e.g. "harvest_batch_001").

    Returns:
        dict with keys: models_scraped, trusted_added, backlog, rejected, dup_skipped,
                        credits_spent, rows_per_credit, remaining_credits.
    """
    queue_path = os.path.join(root, "tire_model_queue.csv")
    ledger_path = os.path.join(root, "coverage_ledger.json")
    paths = {
        "flat": os.path.join(root, "tire_corpus_flat.csv"),
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
        "size_aliases": os.path.join(root, "tire_size_aliases.csv"),
    }

    queue = _load_queue(queue_path)
    led = L.load_ledger(ledger_path)

    totals = {"trusted": 0, "backlog": 0, "rejected": 0, "dup_skipped": 0}
    models_scraped = 0

    for row in queue:
        if row["status"] != "queued":
            continue

        # Hard budget gate — check BEFORE attempting any new scrape
        if run_state.get("run_credits_spent", 0) >= max_credits:
            break

        model_url = row["model_url"]

        # Scrape the model page via the credit firewall
        try:
            result = FC.call(
                ["scrape", "--format", "markdown", model_url],
                expected_max_credits=2,
                run_state=run_state,
                root=root,
            )
        except RuntimeError as exc:
            # Cap reached inside the client (per-run or total) — stop cleanly
            print(f"[harvest] stopping due to firewall: {exc}")
            break

        if result["returncode"] != 0:
            row["status"] = "error"
            reason = (result["stderr"] or result["stdout"] or "non-zero exit")[:200]
            _record_blocked(root, model_url, run_id, reason)
            continue

        # Extract + parse product URLs from scraped markdown
        markdown = result["stdout"]
        # extract_products gives us URL + enrichment fields in one pass
        products = extract_products(markdown)

        # Build a lookup: url -> enrichment dict for O(1) merge below
        enrichment_by_url = {p["url"]: p for p in products}

        identities = []
        for product in products:
            url = product["url"]
            identity = parse_url(url)
            if identity is None:
                continue
            # Required by routing: manufacturer_part_number = mpn
            identity["manufacturer_part_number"] = identity.get("mpn", "")
            # Merge best-effort enrichment fields (never overwrite barcode/size from URL)
            enrich = enrichment_by_url.get(url, {})
            identity["load_index"] = enrich.get("load_index", "")
            identity["speed_rating"] = enrich.get("speed_rating", "")
            identity["tire_type"] = enrich.get("tire_type", "")
            identity["season"] = enrich.get("season", "")
            identities.append(identity)

        if identities:
            counts = write_rows(identities, paths, led, run_id)
            for k in totals:
                totals[k] += counts.get(k, 0)

        models_scraped += 1
        row["status"] = "done"

    # Persist updated queue and ledger
    _save_queue(queue, queue_path)
    L.save_ledger(led, ledger_path)

    # Audit
    audit(root)

    credits_spent = run_state.get("run_credits_spent", 0)
    rows_per_credit = totals["trusted"] / max(1, credits_spent)

    # Get remaining credits (best effort — don't fail if firecrawl unreachable)
    try:
        remaining_credits = FC.get_remaining_credits(root)
    except Exception:
        remaining_credits = -1

    return {
        "models_scraped": models_scraped,
        "trusted_added": totals["trusted"],
        "backlog": totals["backlog"],
        "rejected": totals["rejected"],
        "dup_skipped": totals["dup_skipped"],
        "credits_spent": credits_spent,
        "rows_per_credit": round(rows_per_credit, 1),
        "remaining_credits": remaining_credits,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    run_state = {"run_credits_spent": 0}
    run_id = "harvest_batch_001"
    MAX_CREDITS = 5

    print(f"[harvest] starting run_id={run_id} max_credits={MAX_CREDITS}")
    result = harvest(
        max_credits=MAX_CREDITS,
        root=_ROOT,
        run_state=run_state,
        run_id=run_id,
    )
    print("\n=== HARVEST RESULT ===")
    for k, v in result.items():
        print(f"  {k}: {v}")

    # Final audit
    ok, errs = audit(_ROOT)
    print(f"\n{'AUDIT PASS' if ok else 'AUDIT FAIL'}")
    for e in errs:
        print(f"  - {e}")

    sys.exit(0 if ok else 1)
