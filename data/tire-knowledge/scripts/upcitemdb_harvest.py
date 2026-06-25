#!/usr/bin/env python3
"""
upcitemdb_harvest.py — FREE harvester for upcitemdb.com brand pages.

Fetches brand pages (plain requests, no paid API, no Firecrawl), parses tire
identity rows via upcitemdb_parse.parse_page, tags them verified_db, deduplicates
against the existing corpus, and writes trusted rows to the local tire corpus.

robots.txt ALLOWS /info-* (only /barcode, /query, /norob are disallowed).
Rate-limit: 4 s between fetches (polite). Zero-result brands are retried once
after a 30-second pause (with 6 s between retries) to recover from throttling.
QA checkpoint runs verify_corpus_full.py every 1000 new trusted rows.

INCREMENTAL MODE: harvested_brands.json (at the tire-knowledge root) persists a
JSON list of brand slugs that were successfully fetched+parsed (>0 products OR
confirmed empty after retry). On run start, any slug already in that list is
skipped — saving time and being polite to upcitemdb.  A slug that errored
(network failure, non-200) is NOT marked done and will be retried next run.
"""

import json
import os
import subprocess
import sys
import time

# Make scripts/ importable when run as __main__
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import certifi
import requests

from upcitemdb_parse import parse_page
from write_outputs import write_rows
import ledger as L
from audit_corpus import audit

# ---------------------------------------------------------------------------
# Brand slug list — comprehensive, deduplicated, lowercase / underscore form
# ---------------------------------------------------------------------------
BRAND_SLUGS = [
    # ---- original 48 ----
    "goodyear",
    "michelin",
    "bridgestone",
    "firestone",
    "continental",
    "pirelli",
    "cooper",
    "falken",
    "hankook",
    "kumho",
    "nexen",
    "nitto",
    "toyo",
    "yokohama",
    "dunlop",
    "general",
    "bfgoodrich",
    "nokian",
    "fortune",
    "blackhawk",
    "ironman",
    "hercules",
    "mastercraft",
    "sumitomo",
    "laufenn",
    "kenda",
    "maxxis",
    "sailun",
    "milestar",
    "westlake",
    "gt_radial",
    "linglong",
    "prinx",
    "delinte",
    "sentury",
    "radar",
    "atturo",
    "federal",
    "lexani",
    "lionhart",
    "nankang",
    "gladiator",
    "venom_power",
    "vredestein",
    "uniroyal",
    "kelly",
    "goodride",
    "ohtsu",
    # ---- expanded list ----
    "accelera",
    "achilles",
    "aeolus",
    "americus",
    "antares",
    "apollo",
    "arroyo",
    "atlas",
    "austone",
    "barum",
    "carlisle",
    "ceat",
    "chaoyang",
    "compasal",
    "cordovan",
    "crosswind",
    "dean",
    "doublestar",
    "double_coin",
    "durun",
    "evergreen",
    "firemax",
    "forceland",
    "fullway",
    "fuzion",
    "gislaved",
    "gripmax",
    "haida",
    "hifly",
    "interstate",
    "jinyu",
    "jk_tyre",
    "kapsen",
    "kingstar",
    "landsail",
    "leao",
    "longmarch",
    "mazzini",
    "mickey_thompson",
    "momo",
    "monsta",
    "multimile",
    "nama",
    "neoterra",
    "otani",
    "pace",
    "patriot",
    "powertrac",
    "presa",
    "rapid",
    "riken",
    "roadclaw",
    "roadx",
    "rotalla",
    "rovelo",
    "rydanz",
    "samson",
    "sonar",
    "starfire",
    "superia",
    "thunderer",
    "tigar",
    "tornel",
    "tracmax",
    "travelstar",
    "triangle",
    "vee_rubber",
    "vercelli",
    "vitour",
    "vogue",
    "wanli",
    "waterfall",
    "winda",
    "windforce",
    "zeetex",
    "zenna",
    "zeta",
    # ---- wave-2 additions ----
    "aplus",
    "ardent",
    "atlander",
    "bct",
    "bearway",
    "blacklion",
    "boto",
    "cachland",
    "capitol",
    "centara",
    "constancy",
    "cratos",
    "dcenti",
    "deestone",
    "dextero",
    "dmack",
    "doral",
    "durable",
    "duraturn",
    "effiplus",
    "eldorado",
    "evoluxx",
    "farroad",
    "fengshen",
    "firenza",
    "fortuna",
    "freestar",
    "goform",
    "grenlander",
    "habilead",
    "headway",
    "horizon",
    "ilink",
    "infinity",
    "joyroad",
    "keter",
    "kinforest",
    "kingrun",
    "kpatos",
    "lande",
    "lassa",
    "mabor",
    "marshal",
    "marangoni",
    "mentor",
    "minerva",
    "mirage",
    "nereus",
    "nordexx",
    "ovation",
    "paxaro",
    "petlas",
    "pinso",
    "platin",
    "prestivo",
    "primewell",
    "regal",
    "roadcruza",
    "roadhog",
    "roadmarch",
    "roadone",
    "sava",
    "sebring",
    "seiberling",
    "speedmax",
    "sportiva",
    "sunfull",
    "sunny",
    "sunwide",
    "supermax",
    "syron",
    "taishan",
    "tbb",
    "three_a",
    "toledo",
    "trazano",
    "trelleborg",
    "tristar",
    "tyfoon",
    "vanderbilt",
    "voyager",
    "winrun",
    "winterclaw",
    "zextour",
    "advanta",
    "americus",
    "comforser",
    "cosmo",
    "kanati",
    "maxtrek",
    "sumic",
    "vitour",
    "wildcat",
    # ---- wave-3 additions (Wikipedia-derived; bicycle brands excluded) ----
    "maloya",
    "kaizen",
    "birla",
    "belshina",
    "bkt",
    "dayton",
    "camso",
    "carlstar",
    "casumina",
    "chengshin",
    "matador",
    "semperit",
    "euzkadi",
    "viking",
    "ghandhara",
    "giti",
    "greatwall",
    "runway",
    "douglas",
    "fulda",
    "debica",
    "aurora",
    "hutchinson",
    "irc",
    "kelani",
    "admiral",
    "trailfinder",
    "mrf",
    "kleber",
    "corsa",
    "kormoran",
    "stomil",
    "sigma",
    "taurus",
    "provato",
    "roadstone",
    "nordman",
    "omni_united",
    "roadlux",
    "tecnica",
    "timberland",
    "metzeler",
    "groundspeed",
    "pantera",
    "warrior",
    "solar",
    "titan",
    "silverstone",
    "trayal",
    "diamondback",
    "eurogrip",
    "hero",
    "cst",
    "geostar",
    "fireforce",
    "supercat",
    "yartu",
    "hualin",
    "roadpro",
    "avon",
    "lanvigator",
    "fronway",
    # duplicates intentionally listed (dedup loop above handles them)
    "capitol",
    "double_coin",
    "deestone",
    "dextero",
    "marshal",
    "maxxis",
    "kenda",
    "blacklion",
    "goform",
    "grenlander",
    "aeolus",
    "sunfull",
    "sunwide",
    "durun",
    "kingstar",
    "cooper",
    "hifly",
    "headway",
    "jinyu",
    "fronway",
]

# Deduplicate while preserving order (handles any accidental overlap)
_seen: set = set()
_deduped = []
for _s in BRAND_SLUGS:
    if _s not in _seen:
        _seen.add(_s)
        _deduped.append(_s)
BRAND_SLUGS = _deduped
del _seen, _deduped, _s

# ---------------------------------------------------------------------------
# Incremental harvesting — harvested_brands.json
# ---------------------------------------------------------------------------

_HARVESTED_BRANDS_FILE = "harvested_brands.json"


def _harvested_brands_path(root: str) -> str:
    """Return the absolute path to harvested_brands.json in the corpus root."""
    return os.path.join(root, _HARVESTED_BRANDS_FILE)


def load_harvested_brands(root: str) -> set:
    """
    Load the set of already-harvested brand slugs from harvested_brands.json.
    Returns an empty set if the file does not exist or is malformed.
    """
    path = _harvested_brands_path(root)
    if not os.path.exists(path):
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return set(data)
        return set()
    except Exception:
        return set()


def save_harvested_brands(root: str, done: set) -> None:
    """
    Persist the set of done brand slugs to harvested_brands.json (sorted list).
    Writes atomically by sorting for deterministic diffs.
    """
    path = _harvested_brands_path(root)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sorted(done), f, indent=2)


def should_skip(slug: str, done_set: set) -> bool:
    """
    Return True if *slug* is already in *done_set* and should be skipped
    (i.e. it was successfully harvested in a previous run).

    Pure helper — no I/O, no side effects. Tested directly.
    """
    return slug in done_set


# ---------------------------------------------------------------------------
# HTTP headers — look like a normal browser
# ---------------------------------------------------------------------------
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
}

_BASE_URL = "https://www.upcitemdb.com/info-{slug}_tires"
_SLEEP_S = 4.0          # politeness delay between fetches (first pass)
_RETRY_SLEEP_S = 6.0    # delay between retries (second pass)
_RETRY_PAUSE_S = 30.0   # pause before the retry pass begins


# ---------------------------------------------------------------------------
# QA checkpoint helpers
# ---------------------------------------------------------------------------

def crossed_1000(prev: int, now: int) -> bool:
    """
    Return True if adding (now - prev) new rows crossed a new multiple of 1000.

    Examples:
        crossed_1000(999, 1001) -> True   (crossed 1000)
        crossed_1000(0, 1000)   -> True   (exactly hit 1000)
        crossed_1000(1000, 1500)-> False  (stayed in the same band 1000-1999)
        crossed_1000(1500, 2100)-> True   (crossed 2000)
        crossed_1000(500, 800)  -> False  (no boundary crossed)
    """
    if now <= prev:
        return False
    return (now // 1000) > (prev // 1000)


def run_qa_checkpoint(cumulative: int, root: str, log_path: str) -> bool:
    """
    Run verify_corpus_full.py via subprocess, capture its output, append a
    QA CHECKPOINT block to run-log.md, and return True if QA passed.

    Args:
        cumulative: current total of trusted_added for this run
        root: tire-knowledge root directory
        log_path: path to run-log.md
    """
    script_path = os.path.join(root, "scripts", "verify_corpus_full.py")
    print(
        f"\n[QA CHECKPOINT @ {cumulative} rows] running verify_corpus_full.py ...",
        flush=True,
    )

    try:
        result = subprocess.run(
            ["uv", "run", "python", script_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            cwd=root,
        )
        output = result.stdout + result.stderr
        passed = "ALL DETERMINISTIC CHECKS PASS" in output
        verdict = "PASS" if passed else "FAIL"

        # Extract row count from output if possible
        corpus_total = "unknown"
        for line in output.splitlines():
            if "FULL CORPUS QA" in line and "rows" in line:
                # e.g. "FULL CORPUS QA  —  12345 rows"
                parts = line.split()
                for i, p in enumerate(parts):
                    if p.isdigit():
                        corpus_total = p
                        break

        print(f"[QA CHECKPOINT @ {cumulative} rows] verdict={verdict}, corpus={corpus_total}", flush=True)

        # Append to run-log.md
        entry = (
            f"\n## QA CHECKPOINT @ {cumulative} rows\n"
            f"- verdict: {verdict}\n"
            f"- corpus_total: {corpus_total}\n"
            f"- timestamp: {_utc_now()}\n"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)

        if not passed:
            print("[QA CHECKPOINT] FAIL — halting harvest immediately.", flush=True)
            print(output, flush=True)

        return passed

    except Exception as exc:
        msg = f"[QA CHECKPOINT] exception running verify_corpus_full.py: {exc}"
        print(msg, flush=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"\n## QA CHECKPOINT @ {cumulative} rows\n- verdict: ERROR\n- error: {exc}\n")
        # Treat exception as failure to be safe
        return False


def _utc_now() -> str:
    """Return current UTC time as an ISO-8601 string (no external deps)."""
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Fetch helper
# ---------------------------------------------------------------------------

def fetch(slug: str) -> str | None:
    """
    GET https://www.upcitemdb.com/info-{slug}_tires.
    Returns response text on HTTP 200, None on any error or non-200 status.
    Does NOT sleep — callers are responsible for sleeping before calling this
    so that monkeypatched versions in tests don't need to accept sleep_s.
    """
    url = _BASE_URL.format(slug=slug)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=25, verify=certifi.where())
        if resp.status_code == 200:
            return resp.text
        print(f"  [fetch] {slug}: HTTP {resp.status_code} -> miss", flush=True)
        return None
    except Exception as exc:
        print(f"  [fetch] {slug}: exception {exc}", flush=True)
        return None


# ---------------------------------------------------------------------------
# Internal: process one slug (shared by first pass and retry pass)
# ---------------------------------------------------------------------------

def _process_slug(
    slug: str,
    paths: dict,
    led: dict,
    run_id: str,
    sleep_s: float,
    label: str = "",
) -> dict:
    """
    Fetch, parse, and write rows for one brand slug.

    Returns a dict with keys:
        html_ok (bool), parsed (int), trusted (int), dup_skipped (int),
        backlog (int), rejected (int)
    """
    time.sleep(sleep_s)
    html = fetch(slug)

    if html is None:
        if label:
            print(f"  [{label}] {slug}: MISS", flush=True)
        else:
            print(f"  [harvest] {slug}: MISS", flush=True)
        return {"html_ok": False, "parsed": 0, "trusted": 0, "dup_skipped": 0, "backlog": 0, "rejected": 0}

    identities = parse_page(html, slug)
    source_url = _BASE_URL.format(slug=slug)
    for idn in identities:
        idn["evidence_level"] = "verified_db"
        idn["source_url"] = source_url

    parsed_count = len(identities)

    if identities:
        counts = write_rows(identities, paths, led, run_id)
    else:
        counts = {"trusted": 0, "backlog": 0, "rejected": 0, "dup_skipped": 0}

    tag = label if label else "harvest"
    print(
        f"  [{tag}] {slug}: parsed={parsed_count} "
        f"trusted={counts['trusted']} dup={counts['dup_skipped']} "
        f"backlog={counts['backlog']} rejected={counts['rejected']}",
        flush=True,
    )

    return {
        "html_ok": True,
        "parsed": parsed_count,
        "trusted": counts.get("trusted", 0),
        "dup_skipped": counts.get("dup_skipped", 0),
        "backlog": counts.get("backlog", 0),
        "rejected": counts.get("rejected", 0),
    }


# ---------------------------------------------------------------------------
# Main harvest function
# ---------------------------------------------------------------------------

def harvest(root: str) -> dict:
    """
    Harvest all brands in BRAND_SLUGS, write verified_db rows to the corpus.

    Behavior:
      0. Incremental skip: load harvested_brands.json; skip any slug already
         present (saves time and is polite to upcitemdb). Only failed fetches
         (network error, non-200) are NOT marked done — they retry next run.
      1. First pass: fetch every non-skipped brand with _SLEEP_S between requests.
         Brands that return 0 products are recorded as "zero_first_pass".
      2. After a _RETRY_PAUSE_S pause, retry zero-product brands once with
         _RETRY_SLEEP_S between requests.  A brand still returning 0 on retry
         is treated as genuinely empty / absent and marked done.
      3. QA checkpoint (verify_corpus_full.py) fires every time cumulative
         trusted_added crosses a new multiple of 1000.  If QA fails, harvest
         stops immediately.

    Args:
        root: tire-knowledge root directory (contains tire_corpus_flat.csv etc.)

    Returns:
        dict with keys:
            brands_hit, brands_missed, brands_skipped, products_parsed,
            trusted_added, dup_skipped, rejected, backlog, audit_ok
    """
    ledger_path = os.path.join(root, "coverage_ledger.json")
    log_path = os.path.join(root, "run-log.md")
    paths = {
        "flat": os.path.join(root, "tire_corpus_flat.csv"),
        "identifiers": os.path.join(root, "tire_identifiers.csv"),
        "size_aliases": os.path.join(root, "tire_size_aliases.csv"),
    }

    run_id = "upcitemdb_001"
    led = L.load_ledger(ledger_path)

    # ------------------------------------------------------------------
    # Load incremental state
    # ------------------------------------------------------------------
    done_brands: set = load_harvested_brands(root)
    print(
        f"[harvest] incremental: {len(done_brands)} brand(s) already done — will skip",
        flush=True,
    )

    totals = {"trusted": 0, "backlog": 0, "rejected": 0, "dup_skipped": 0}
    brands_hit = 0
    brands_missed = 0
    brands_skipped = 0
    products_parsed = 0
    per_brand: dict[str, dict] = {}  # slug -> {parsed, trusted}

    # Cumulative row count across the entire run (for QA checkpoints)
    cumulative_trusted = 0
    qa_aborted = False

    # Slugs that returned 0 products on the first pass (candidates for retry)
    zero_first_pass: list[str] = []

    # ------------------------------------------------------------------
    # FIRST PASS
    # ------------------------------------------------------------------
    for slug in BRAND_SLUGS:
        # INCREMENTAL SKIP: already successfully harvested in a prior run
        if should_skip(slug, done_brands):
            print(f"[harvest] SKIP {slug} (already in harvested_brands.json)", flush=True)
            brands_skipped += 1
            continue

        print(f"[harvest] fetching {slug} ...", flush=True)

        res = _process_slug(slug, paths, led, run_id, sleep_s=_SLEEP_S, label="harvest")

        if not res["html_ok"]:
            brands_missed += 1
            per_brand[slug] = {"parsed": 0, "trusted": 0}
            # Network/non-200 error: do NOT mark done — retry next run
            continue

        parsed_count = res["parsed"]
        trusted_this = res["trusted"]
        products_parsed += parsed_count

        for k in ("trusted", "backlog", "rejected", "dup_skipped"):
            totals[k] += res[k]

        if parsed_count == 0:
            # Got a 200 but zero products — may be throttled; schedule retry
            zero_first_pass.append(slug)
            per_brand[slug] = {"parsed": 0, "trusted": 0}
            # Don't mark done yet; will resolve after retry
        else:
            brands_hit += 1
            per_brand[slug] = {"parsed": parsed_count, "trusted": trusted_this}
            # Mark this slug as done so future runs skip it
            done_brands.add(slug)
            save_harvested_brands(root, done_brands)

        # QA checkpoint check
        prev = cumulative_trusted
        cumulative_trusted += trusted_this
        if crossed_1000(prev, cumulative_trusted):
            if not run_qa_checkpoint(cumulative_trusted, root, log_path):
                qa_aborted = True
                break

    # ------------------------------------------------------------------
    # RETRY PASS (zero-product brands from first pass, if any)
    # ------------------------------------------------------------------
    if zero_first_pass and not qa_aborted:
        print(
            f"\n[harvest] {len(zero_first_pass)} brand(s) returned 0 products on first pass "
            f"(possible throttle). Pausing {_RETRY_PAUSE_S}s before retry ...",
            flush=True,
        )
        time.sleep(_RETRY_PAUSE_S)
        print(f"[harvest] starting retry pass: {zero_first_pass}", flush=True)

        for slug in zero_first_pass:
            print(f"[harvest] RETRY fetching {slug} ...", flush=True)

            res = _process_slug(slug, paths, led, run_id, sleep_s=_RETRY_SLEEP_S, label="retry")

            if not res["html_ok"]:
                # Fetch failed outright on retry — count as missed; do NOT mark done
                brands_missed += 1
                per_brand[slug] = {"parsed": 0, "trusted": 0}
                continue

            parsed_count = res["parsed"]
            trusted_this = res["trusted"]
            products_parsed += parsed_count

            for k in ("trusted", "backlog", "rejected", "dup_skipped"):
                totals[k] += res[k]

            if parsed_count == 0:
                # Still 0 — genuinely empty / absent brand; mark done so we don't refetch
                brands_missed += 1
                per_brand[slug] = {"parsed": 0, "trusted": 0}
                done_brands.add(slug)
                save_harvested_brands(root, done_brands)
            else:
                brands_hit += 1
                per_brand[slug] = {"parsed": parsed_count, "trusted": trusted_this}
                done_brands.add(slug)
                save_harvested_brands(root, done_brands)

            # QA checkpoint check
            prev = cumulative_trusted
            cumulative_trusted += trusted_this
            if crossed_1000(prev, cumulative_trusted):
                if not run_qa_checkpoint(cumulative_trusted, root, log_path):
                    qa_aborted = True
                    break

    # ------------------------------------------------------------------
    # Persist ledger
    # ------------------------------------------------------------------
    L.save_ledger(led, ledger_path)

    # Run final corpus audit
    ok, errs = audit(root)

    result = {
        "brands_hit": brands_hit,
        "brands_missed": brands_missed,
        "brands_skipped": brands_skipped,
        "products_parsed": products_parsed,
        "trusted_added": totals["trusted"],
        "dup_skipped": totals["dup_skipped"],
        "rejected": totals["rejected"],
        "backlog": totals["backlog"],
        "audit_ok": ok,
        "qa_aborted": qa_aborted,
        "_audit_errors": errs,
        "_per_brand": per_brand,
    }

    if qa_aborted:
        result["audit_ok"] = False  # surface the abort clearly

    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Windows stdout utf-8 guard
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print(f"[upcitemdb_harvest] starting run_id=upcitemdb_001")
    print(f"[upcitemdb_harvest] root={_ROOT}")
    print(f"[upcitemdb_harvest] brands to fetch: {len(BRAND_SLUGS)}")
    print(f"[upcitemdb_harvest] inter-request sleep: {_SLEEP_S}s (retry: {_RETRY_SLEEP_S}s)")
    est_min = len(BRAND_SLUGS) * _SLEEP_S / 60
    print(f"[upcitemdb_harvest] estimated time (first pass only): ~{est_min:.1f} min")
    print()

    result = harvest(_ROOT)

    print()
    print("=== HARVEST SUMMARY ===")
    summary_keys = [
        "brands_hit", "brands_missed", "brands_skipped", "products_parsed",
        "trusted_added", "dup_skipped", "rejected", "backlog",
        "audit_ok", "qa_aborted",
    ]
    for k in summary_keys:
        print(f"  {k}: {result[k]}")

    print()
    print("=== PER-BRAND RESULTS ===")
    for slug, counts in result["_per_brand"].items():
        print(f"  {slug}: parsed={counts['parsed']} trusted={counts['trusted']}")

    print()
    if result["audit_ok"]:
        print("AUDIT PASS")
    else:
        print("AUDIT FAIL")
        for e in result["_audit_errors"]:
            print(f"  - {e}")

    sys.exit(0 if result["audit_ok"] else 1)
