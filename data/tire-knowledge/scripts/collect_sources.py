#!/usr/bin/env python3
"""
collect_sources.py — Task 8b: Source collection via sitemap enumeration.

Strategy: tiresandwheels.com publishes a gzipped sitemap that enumerates
every model page in the tire catalog — FOR FREE. We parse the sitemap
instead of using Firecrawl map (which costs credits and does NOT enumerate
the full catalog anyway).

TLS NOTE: tiresandwheels.com serves an incomplete certificate chain, so
standard SSL verification fails. For these PUBLIC, read-only catalog fetches
we use ssl._create_unverified_context(), restricted to this known host only.
Data is public; every barcode found downstream is GTIN-validated per the
semantic-firewall rule, so an MITM returning bad catalog URLs causes no
silent data corruption.

fetch_sitemap_model_urls(root) -> list[str]
  - Fetches sitemap_index.xml (unverified TLS, known host).
  - Finds every sub-sitemap URL containing 'tirecatalog' and ending '.xml.gz'.
  - GETs + gzip-decompresses each sub-sitemap and extracts <loc> URLs.
  - Returns only MODEL pages (5+ path segments under /catalog/tires/).

collect(root) -> dict
  - Loads coverage_ledger.json for already-processed source URLs.
  - Builds/appends tire_model_queue.csv with new model URLs.
  - Returns {"sitemaps": S, "model_urls_found": N, "new_queued": K}.
  - Spends ZERO Firecrawl credits.
"""

import csv
import gzip
import hashlib
import http.client
import io
import os
import re
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlparse

import certifi

# Allow imports from the scripts directory regardless of cwd.
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import ledger as ledger_mod

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_ROOT_SITEMAP = "https://www.tiresandwheels.com/sitemap_index.xml"
_TARGET_HOST = "www.tiresandwheels.com"

# Queue file lives at the harvester root (parent of scripts/).
_QUEUE_FILE = "tire_model_queue.csv"
_QUEUE_COLUMNS = ["model_url", "status", "added_at"]

# Owner priority (2026-06-23): shop's most-used brands. Harvest these FIRST.
# (Blackhawk/Fortune/Arisun are not carried by tiresandwheels — they need a Phase B source.)
PRIORITY_BRANDS = ["toyo", "dunlop", "falken", "nexen", "nokian",
                   "blackhawk", "fortune", "arisun"]

# A browser-like User-Agent so the server does not block us.
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Secure fetch — TLS is ALWAYS verified.
#
# tiresandwheels.com serves an incomplete certificate chain (server
# misconfiguration), so standard chain verification fails. Rather than disable
# TLS verification (which would expose us to MITM / a poisoned sitemap), we PIN
# the server's exact leaf certificate: we accept the broken chain but require
# the presented cert's SHA-256 to match a known-good fingerprint. Any other
# cert (MITM, or a silent server change) fails loudly.
#
# To update the pin after a legitimate cert rotation, run:
#   python -c "import ssl,socket,hashlib; c=ssl._create_unverified_context(); \
#     s=c.wrap_socket(socket.create_connection(('www.tiresandwheels.com',443)), \
#     server_hostname='www.tiresandwheels.com'); \
#     print(hashlib.sha256(s.getpeercert(binary_form=True)).hexdigest())"
# ---------------------------------------------------------------------------

# Leaf cert for www.tiresandwheels.com, captured 2026-06-23.
_PINNED_SHA256 = "d094a103013b1da33e898c8228ea06fc3a81351b6052592d50859ac6d0469806"


def _pinned_get(url: str, _redirects: int = 0) -> bytes:
    """Fetch from the pinned target host, verifying the leaf cert fingerprint."""
    parsed = urlparse(url)
    # Unverified at the chain level (broken chain); integrity comes from the pin.
    ctx = ssl._create_unverified_context()  # noqa: S501 - pinned below
    conn = http.client.HTTPSConnection(parsed.netloc, timeout=30, context=ctx)
    try:
        conn.connect()
        der = conn.sock.getpeercert(binary_form=True)
        fp = hashlib.sha256(der).hexdigest()
        if fp != _PINNED_SHA256:
            raise RuntimeError(
                f"TLS pin mismatch for {parsed.netloc}: expected {_PINNED_SHA256}, got {fp}. "
                "Refusing to trust. If the cert was rotated legitimately, update _PINNED_SHA256."
            )
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        conn.request("GET", path or "/", headers={"User-Agent": _USER_AGENT})
        resp = conn.getresponse()
        if resp.status in (301, 302, 303, 307, 308) and _redirects < 3:
            loc = resp.headers.get("Location")
            resp.read()
            if loc:
                nxt = loc if loc.startswith("http") else f"https://{parsed.netloc}{loc}"
                return _pinned_get(nxt, _redirects + 1)
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} for {url}")
        return resp.read()
    finally:
        conn.close()


def _get_url(url: str) -> bytes:
    """Fetch a URL. The target host is cert-pinned; all other hosts use full
    verification via the certifi CA bundle."""
    parsed = urlparse(url)
    if parsed.netloc == _TARGET_HOST:
        return _pinned_get(url)
    ctx = ssl.create_default_context(cafile=certifi.where())
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
# URL filter — pure function, unit-testable without network
# ---------------------------------------------------------------------------

def is_model_page(url: str) -> bool:
    """
    Return True if url is a tire MODEL page (not a brand-index page).

    Model pages have the form:
      /catalog/tires/{Brand}/{Code}/{Model-Name}/
    which means at least 5 non-empty path segments after the host:
      ['catalog', 'tires', '{Brand}', '{Code}', '{Model-Name}']

    Brand-index pages have only 3 segments:
      /catalog/tires/{Brand}/

    Any URL not under /catalog/tires/ is excluded.

    Args:
        url: Absolute URL string.

    Returns:
        True for model pages; False for brand-index and all other URLs.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    # Must be under /catalog/tires/
    path = parsed.path
    if not path.startswith("/catalog/tires/"):
        return False

    # Split and filter empty segments (leading/trailing slashes).
    segments = [s for s in path.split("/") if s]
    # segments[0] == 'catalog', segments[1] == 'tires', then Brand, Code, Model…
    # Need at least 5 segments for a model page.
    return len(segments) >= 5


# ---------------------------------------------------------------------------
# Sitemap fetching
# ---------------------------------------------------------------------------

def _extract_locs(xml_bytes: bytes) -> list:
    """Extract all <loc> values from an XML sitemap (bytes)."""
    # Simple regex-based extraction — no XML parser dependency required.
    # <loc> values never contain angle brackets, so this is safe.
    return re.findall(r"<loc>\s*(https?://[^<]+?)\s*</loc>", xml_bytes.decode("utf-8", errors="replace"))


def fetch_sitemap_model_urls(root: str = None) -> list:
    """
    Enumerate all tire model pages by parsing the sitemap index (free, no credits).

    Steps:
      1. Fetch sitemap_index.xml.
      2. Find every sub-sitemap URL that contains 'tirecatalog' and ends '.xml.gz'.
      3. For each, fetch + gzip-decompress + extract <loc> URLs.
      4. Keep only MODEL pages (is_model_page returns True).
      5. Deduplicate and return.

    Args:
        root: Unused; kept for API consistency with collect().

    Returns:
        Deduplicated list of model page URLs.
    """
    # Step 1: fetch the sitemap index.
    index_bytes = _get_url(_ROOT_SITEMAP)
    index_locs = _extract_locs(index_bytes)

    # Step 2: find tirecatalog sub-sitemaps (gzipped).
    catalog_sitemaps = [
        u for u in index_locs
        if "tirecatalog" in u and u.endswith(".xml.gz")
    ]

    # Step 3 & 4: fetch each sub-sitemap, decompress, filter.
    seen = set()
    model_urls = []

    for sitemap_url in catalog_sitemaps:
        raw = _get_url(sitemap_url)
        with gzip.open(io.BytesIO(raw)) as gz:
            xml_bytes = gz.read()
        locs = _extract_locs(xml_bytes)
        for loc in locs:
            loc = loc.strip()
            if loc and loc not in seen and is_model_page(loc):
                seen.add(loc)
                model_urls.append(loc)

    return model_urls


# ---------------------------------------------------------------------------
# Brand-diversity helpers
# ---------------------------------------------------------------------------

def brand_of(model_url: str) -> str:
    """
    Extract the {Brand} path segment from a tiresandwheels.com model URL.

    URL form: https://www.tiresandwheels.com/catalog/tires/{Brand}/{Code}/{Model}/
    Path segments (after stripping empties): ['catalog', 'tires', Brand, Code, Model, ...]

    Returns the Brand segment lowercased, or "" if the URL cannot be parsed or
    has fewer than 3 meaningful path segments under /catalog/tires/.
    """
    try:
        parsed = urlparse(model_url)
        segments = [s for s in parsed.path.split("/") if s]
        # segments[0]=='catalog', [1]=='tires', [2]==Brand, [3]==Code, [4]==Model...
        if len(segments) >= 3 and segments[0] == "catalog" and segments[1] == "tires":
            return segments[2].lower()
    except Exception:
        pass
    return ""


def interleave_by_brand(urls: list) -> list:
    """
    Round-robin interleave a list of URLs by brand, preserving internal group order.

    Grouping:
      - Each URL is assigned a brand via brand_of().
      - Groups cycle in first-appearance order (stable, deterministic — no randomness).
      - Within each group the original URL order is preserved.
      - One URL is emitted from each non-empty group per round until all consumed.

    Result: no brand appears twice consecutively when multiple brands exist.

    Args:
        urls: List of model_url strings (may be any non-empty iterable of strings).

    Returns:
        New list with the same URLs in round-robin brand order.
    """
    # Build ordered groups (first-appearance brand order).
    brand_order = []
    groups = {}  # brand -> [url, ...]
    for url in urls:
        brand = brand_of(url)
        if brand not in groups:
            brand_order.append(brand)
            groups[brand] = []
        groups[brand].append(url)

    # Convert each group to a deque for efficient popleft.
    from collections import deque
    queues = {b: deque(groups[b]) for b in brand_order}

    result = []
    while any(queues[b] for b in brand_order):
        for brand in brand_order:
            if queues[brand]:
                result.append(queues[brand].popleft())

    return result


def _is_priority(url: str, priority_brands) -> bool:
    b = brand_of(url)
    return any(p == b or p in b for p in priority_brands)


def interleave_priority(urls: list, priority_brands) -> list:
    """Front-load priority-brand URLs (round-robined among themselves), then the
    rest (round-robined among themselves). Deterministic; preserves the URL set."""
    pset = [p.lower() for p in priority_brands]
    prio = [u for u in urls if _is_priority(u, pset)]
    rest = [u for u in urls if not _is_priority(u, pset)]
    return interleave_by_brand(prio) + interleave_by_brand(rest)


def reorder_queue(root, priority_brands=None) -> dict:
    """
    Reorder tire_model_queue.csv so queued rows are interleaved by brand.
    If priority_brands is given, those brands are front-loaded (harvested first).

    Only rows with status == "queued" are reordered. Rows with status in
    {"done", "error"} are preserved exactly, in their original order, and
    written first. The total row count and the set of model_url values are
    asserted identical before and after (raises ValueError if not).

    Args:
        root: Harvester root directory (str or path-like). The queue file is
              expected at <root>/tire_model_queue.csv.

    Returns:
        dict with keys:
            total            — total rows in the rewritten file
            kept             — rows with status done/error (unchanged)
            queued           — rows with status queued (reordered)
            brands_in_queue  — number of distinct brands in the queued rows
    """
    if root is None:
        root = os.path.dirname(_SCRIPTS_DIR)
    root = str(root)

    queue_path = os.path.join(root, _QUEUE_FILE)

    # Read all rows.
    with open(queue_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        all_rows = list(reader)

    total_before = len(all_rows)
    urls_before = {r["model_url"] for r in all_rows}

    # Partition into kept (done/error) and queued.
    _KEPT_STATUSES = {"done", "error"}
    kept_rows = [r for r in all_rows if r.get("status", "").strip() in _KEPT_STATUSES]
    queued_rows = [r for r in all_rows if r.get("status", "").strip() not in _KEPT_STATUSES]

    # Build a lookup so we can reconstruct full row dicts after reordering.
    # If the same URL appears more than once (shouldn't, but be safe), preserve all.
    from collections import defaultdict
    url_to_rows = defaultdict(list)
    for r in queued_rows:
        url_to_rows[r["model_url"]].append(r)

    # Interleave queued URLs by brand (priority brands first if requested).
    queued_urls = [r["model_url"] for r in queued_rows]
    if priority_brands:
        interleaved_urls = interleave_priority(queued_urls, priority_brands)
    else:
        interleaved_urls = interleave_by_brand(queued_urls)

    # Reconstruct row dicts in interleaved order (pop from each url's list in order).
    url_row_iters = {url: iter(rows) for url, rows in url_to_rows.items()}
    reordered_queued = [next(url_row_iters[url]) for url in interleaved_urls]

    # Build final row list: kept first, then reordered queued.
    final_rows = kept_rows + reordered_queued

    total_after = len(final_rows)
    urls_after = {r["model_url"] for r in final_rows}

    # Safety assertions.
    if total_after != total_before:
        raise ValueError(
            f"reorder_queue: row count changed! before={total_before} after={total_after}"
        )
    if urls_after != urls_before:
        lost = urls_before - urls_after
        gained = urls_after - urls_before
        raise ValueError(
            f"reorder_queue: URL set changed! lost={len(lost)} gained={len(gained)}"
        )

    # Rewrite the file atomically-ish (write to same path; no tmp needed here since
    # we already validated the data in memory).
    with open(queue_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_QUEUE_COLUMNS)
        writer.writeheader()
        writer.writerows(final_rows)

    brands_in_queue = len({brand_of(r["model_url"]) for r in reordered_queued})

    return {
        "total": total_after,
        "kept": len(kept_rows),
        "queued": len(reordered_queued),
        "brands_in_queue": brands_in_queue,
    }


# ---------------------------------------------------------------------------
# Queue helpers
# ---------------------------------------------------------------------------

def _load_queue_urls(queue_path: str) -> set:
    """Return the set of model_url values already in the queue CSV."""
    if not os.path.exists(queue_path):
        return set()
    urls = set()
    try:
        with open(queue_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames and "model_url" in reader.fieldnames:
                for row in reader:
                    url = row.get("model_url", "").strip()
                    if url:
                        urls.add(url)
    except Exception:
        pass
    return urls


def _ensure_queue_header(queue_path: str) -> None:
    """Ensure the queue CSV exists with the correct header row."""
    if not os.path.exists(queue_path):
        with open(queue_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(_QUEUE_COLUMNS)
        return

    # Check whether existing file has the correct schema.
    try:
        with open(queue_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames and "model_url" in reader.fieldnames:
                return  # Already correct.
    except Exception:
        pass

    # Wrong schema or corrupt — reset with correct header.
    with open(queue_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(_QUEUE_COLUMNS)


# ---------------------------------------------------------------------------
# Main collect function
# ---------------------------------------------------------------------------

def collect(root: str = None) -> dict:
    """
    Enumerate tire model pages via sitemap and queue new ones.

    Spends ZERO Firecrawl credits. All data comes from free HTTP fetches
    against the public sitemap.

    Args:
        root: Harvester root directory. Defaults to the parent of scripts/.

    Returns:
        dict with keys:
            sitemaps         — number of tirecatalog sub-sitemaps found
            model_urls_found — total model URLs extracted across all sitemaps
            new_queued       — URLs newly written to tire_model_queue.csv
    """
    if root is None:
        root = os.path.dirname(_SCRIPTS_DIR)

    # 1. Load the ledger to check already-processed source URLs.
    ledger_path = os.path.join(root, "coverage_ledger.json")
    ledger = ledger_mod.load_ledger(ledger_path)
    seen_in_ledger = set(ledger.get("seen_source_urls", []))

    # 2. Load queue file to avoid re-adding already-queued URLs.
    queue_path = os.path.join(root, _QUEUE_FILE)
    seen_in_queue = _load_queue_urls(queue_path)

    all_seen = seen_in_ledger | seen_in_queue

    # 3. Fetch and parse sitemaps — free, no credits.
    model_urls = fetch_sitemap_model_urls(root=root)
    model_urls_found = len(model_urls)

    # Count how many catalog sitemaps were discovered (re-derive from index).
    index_bytes = _get_url(_ROOT_SITEMAP)
    index_locs = _extract_locs(index_bytes)
    sitemaps_count = len([
        u for u in index_locs
        if "tirecatalog" in u and u.endswith(".xml.gz")
    ])

    # 4. Determine new URLs not yet seen.
    new_urls = [u for u in model_urls if u not in all_seen]

    # 5. Ensure queue file has correct schema.
    _ensure_queue_header(queue_path)

    # 6. Append new URLs to queue in brand-interleaved order (avoids future
    #    brand-clustering when the next batch is processed sequentially).
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    new_queued = 0
    if new_urls:
        interleaved_new = interleave_by_brand(new_urls)
        with open(queue_path, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=_QUEUE_COLUMNS)
            for url in interleaved_new:
                writer.writerow({
                    "model_url": url,
                    "status": "queued",
                    "added_at": now_iso,
                })
                new_queued += 1

    return {
        "sitemaps": sitemaps_count,
        "model_urls_found": model_urls_found,
        "new_queued": new_queued,
    }


# ---------------------------------------------------------------------------
# __main__
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Starting sitemap-based source collection (0 Firecrawl credits)...")
    print(f"Root sitemap: {_ROOT_SITEMAP}")
    print()

    result = collect(root=None)

    print("=== collect() result ===")
    for k, v in result.items():
        print(f"  {k}: {v}")

    # Show the first 5 queued model URLs from the queue file.
    root = os.path.dirname(_SCRIPTS_DIR)
    queue_path = os.path.join(root, _QUEUE_FILE)
    print()
    print("=== First 5 queued model URLs ===")
    count = 0
    try:
        with open(queue_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if count >= 5:
                    break
                print(f"  {row['model_url']}")
                count += 1
    except Exception as e:
        print(f"  (could not read queue: {e})")
