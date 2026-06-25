# Tire Barcode Harvester — Spec v4 (Firecrawl, credit-bulletproof)

**Date:** 2026-06-22
**Owner:** Santiago (djsanti88@gmail.com)
**Sandbox (only writable root):** `C:\Users\djsan\inventory\data\tire-knowledge`
**Status:** APPROVED DESIGN — awaiting spec review before implementation plan.

This spec supersedes the Amazon-first approach in `CLAUDE_CODE_HANDOFF.md` and adapts the
`MASTER PROMPT Claude Code Local Tire Barcode Harvester` to a Firecrawl-based pipeline with a
hard credit cap. It does not weaken any safety, GTIN, schema, or anti-fake-proof rule from
either source.

---

## 1. Goal

Grow a verified tire barcode database (long-term 30,000 rows) that lets the Smart Inventory
Scanner resolve a scanned barcode to a product instantly. A row is *useful to the scanner* when
it carries `barcode + brand + model + size` plus an MPN or SKU. Everything else is enrichment.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Strategy | **Phase A:** tiresandwheels.com `map` + URL-parse spine. **Phase B:** multisource rotation *after* Phase A is exhausted. |
| 2 | Quality bar for a trusted row | Valid GTIN barcode **+** (MPN **or** SKU) **+** brand + model + size. All URL-derived. load/speed/type/season → enrichment backlog. |
| 3 | Credit cap | **TOTAL_CAP = 50**, **PER_RUN_CAP = 15**, rows-per-credit floor (set after Gate 2/3 measurement). 110 credits held in reserve. |
| 4 | Verification | `verified_1src_strong` from URL-encoded UPC + passing GTIN check. Phase B cross-checks any reappearing barcode for free. No credits spent purely on verification. |
| 5 | Automation | Manual (`run_once.py`) now. `scheduler.py` + Task Scheduler built but **DISABLED** until Phase B and an explicit owner flip. |
| 6 | Gemini QA | **Deferred but wired.** Gate + config (`GEMINI_QA_ALLOWED=false` default) + output dirs stubbed now; batch QA implemented later. Review-only, never source-of-truth, never creates/overrides a barcode. |

---

## 3. Architecture — two phases

**Phase A — tiresandwheels.com spine**
`map` catalog → URL queue → parse identity from URL (free) → validate locally (free) →
route/write trusted rows → optional metered listing enrichment → audit.

**Phase B — multisource rotation (later)**
Amazon + major retailers + manufacturer catalogs, same gates and credit firewall. A barcode
that reappears here auto-cross-checks the Phase A row (free hardening).

---

## 4. Firecrawl credit firewall (bulletproof core)

Nothing calls the Firecrawl CLI directly. Every call routes through `firecrawl_client.py`, which:

- Loads `firecrawl_policy.json`: `TOTAL_CAP`, `PER_RUN_CAP`, `ROWS_PER_CREDIT_FLOOR`,
  `STEALTH_ALLOWED=false`, `KILL_SWITCH_FILE=.firecrawl_STOP`.
- Reads `firecrawl --status` credits **before and after** each call; records exact credits spent
  per run in `run-log.md` and the ledger.
- **Kill switch:** if `.firecrawl_STOP` exists, abort immediately before any spend.
- **Cap enforcement:** refuse a call that would exceed `PER_RUN_CAP` or `TOTAL_CAP`; abort clean.
- **Efficiency abort:** if a run falls below `ROWS_PER_CREDIT_FLOOR`, stop the run and flag it.
- **Escalation order (cheapest first):** `map` → listing-page `scrape` → product-page `scrape`
  → stealth proxy (only if `STEALTH_ALLOWED=true`; off by default).

---

## 5. Components (`tire-knowledge/scripts/`)

| Script | Role | Status |
|---|---|---|
| `validate.py` | GTIN / size / UID / completeness — single source of truth | exists; harden + add MPN/SKU rule + example regression fixture; align `barcode_type` labels to schema |
| `firecrawl_client.py` | Metered wrapper: cap, kill switch, logging, escalation | NEW |
| `parse_tiresandwheels_url.py` | Zero-credit URL → `{barcode, mpn, sku, brand, model, size}` | NEW |
| `seed_from_example.py` | Import the 95 example rows (`TIRE_C_1`) free; prove pipeline | NEW |
| `collect_sources.py` | `map` → candidate URL queue | NEW |
| `harvest_tiresandwheels.py` | queue → URL parse → validate → route | NEW |
| `enrich_listings.py` | Metered listing scrapes → fill load/speed/season; upgrade backlog | NEW |
| `write_outputs.py` | Idempotent writes, schema v3, SKU → identifiers, size → aliases | NEW |
| `audit_corpus.py` | Schema, dup barcode/UID, GTIN, size, ledger + credit-log consistency | NEW |
| `run_once.py` | Manual entry point / proof runs | NEW |
| `scheduler.py` + `setup_local_task.py` | Built but INERT until enabled | NEW (disabled) |
| `gemini_qa_batch.py` | Optional, gated, review-only | DEFERRED (gate wired now) |

---

## 6. Data flow (per URL)

`map` → URL queue → **parse URL** → `{barcode, mpn, sku, brand, model, size}` →
validate GTIN + normalize size → dedup vs ledger → **route:**

- **trusted** — barcode (valid GTIN) + (MPN or SKU) + brand + model + size all present
- **backlog** — identity OK but a required field missing
- **rejected** — GTIN fails or size unparseable (reason recorded)

→ write CSVs (SKU → `tire_identifiers.csv`, size variants → `tire_size_aliases.csv`) →
update `coverage_ledger.json` → `audit_corpus.py`. A later enrichment pass adds
load/speed/season and bumps completeness ~70 → ~90.

---

## 7. Schema v3 (unchanged — 20 columns, exact order)

`canonical_product_uid, brand, model, size_canonical, size_compact, load_index, speed_rating,
tire_type, season, barcode, barcode_type, manufacturer_part_number, source_url, evidence_level,
usable_for, current_status, missing_fields, field_completeness_score, harvested_at, run_id`

No `retailer_sku` and no `size_shop` in the flat file. SKU → `tire_identifiers.csv`;
size aliases → `tire_size_aliases.csv`.

---

## 8. Non-negotiable safety rules (carried forward)

Never invent/guess/repair a barcode or part number. Never keep invalid GTINs in trusted rows.
Never parse barcodes as numbers; always preserve leading zeros. No row without a parseable size
enters the corpus. No paid API beyond the Firecrawl carve-out (≤ 50 credits) and the gated
Gemini QA. Never touch app code. Never write outside the sandbox. No deploy/push/merge.

---

## 9. Error handling

Kill switch → abort. Cap exceeded → abort clean. Below efficiency floor → abort + flag. Stale
lock (>90 min, no live process) → reclaim. CAPTCHA/block → `blocked_sources.csv`, move on.
Incremental append + flush so an interrupt never corrupts a partial row.

---

## 10. Proof gates (sized, credit-aware)

- **Gate 0 — FREE:** `seed_from_example.py` imports 95 rows → proves validate/write/dedup/audit/
  ledger end-to-end at **0 credits**; rerun = 0 duplicates.
- **Gate 1 — Preflight:** paths writable, Python + Playwright (if used) OK, `firecrawl --status`
  reads credits, `firecrawl_policy.json` loads, kill switch verified.
- **Gate 2 — Map proof:** 1 `map` call; measure URLs returned + credits spent; parse → trusted
  rows; all GTIN valid; exact 20-col schema; no dups.
- **Gate 3 — 50-row proof:** ≥ 50 trusted rows; rerun twice = 0 duplicates; `audit_corpus.py`
  passes; **report actual rows-per-credit** (sets the floor).
- **Gate 4 — Enrichment sample:** a few listing scrapes upgrade backlog rows (load/speed/season).
- Scheduler stays disabled. Owner reviews rows-per-credit, then decides scale / cap raise.

---

## 11. Doctrine reconciliation

Recorded in `RECONCILIATION.md`: the Firecrawl carve-out **overrides** the three "no paid API"
bans (master prompt, handoff, app CLAUDE.md), **scoped to the 50-credit cap**. All other rules
preserved: no invented data, GTIN validation, schema v3, no app-code edits, no deploy/push/merge.
Source contradiction resolved: tiresandwheels.com = proven Tier 1; Amazon demoted to Phase B.

---

## 12. Out of scope (YAGNI)

Phase B multisource implementation, Gemini QA implementation, scheduler activation, stealth
proxy, any app-code change, any commit/push. These are explicitly later or owner-gated.

---

## 13. Open items

- `ROWS_PER_CREDIT_FLOOR` value — set empirically after Gate 2/3.
- Confirm tiresandwheels.com `robots.txt` allows the catalog paths (Firecrawl respects robots by
  default; verify during Gate 1).
