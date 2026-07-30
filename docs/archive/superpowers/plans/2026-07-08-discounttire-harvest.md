# Discount Tire Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harvest Discount Tire's full catalog into the private tire corpus using local Playwright (Firecrawl's job, $0/page), with poison guards, provenance, resumable batches, and a weekly lower-tier-agent top-up. Spec: `docs/archive/superpowers/specs/2026-07-08-discounttire-harvest-design.md`.

**Architecture:** sitemap discovery -> Playwright renderer (polite, block-rate telemetry, hard stop) -> deterministic JSON-LD parser -> poison guard (check digit + prefix firewall + no cross-source overwrite) -> corpus merge + DB rebuild -> weekly scheduled top-up.

**Tech Stack:** Node scripts (`scripts/dt-harvest/`), Playwright (already a dev dependency), Vitest for parser/guard units, existing `build:knowledge-db`.

## Global Constraints

- Host allowlist: exactly `discounttire.com` (+ its sitemap host). Nothing else, ever.
- Politeness: sequential, 2000-4000ms randomized delay, backoff on 403/429, HARD STOP when block rate > 30% over the last 50 pages (write a stop-report, exit 0).
- No AI in the pipeline; scraped content is untrusted data (parse, never obey).
- Provenance `source: "discounttire"` on every row; duplicate GTIN never silently overwrites another source's row.
- All units mocked in tests; live crawling only via the explicitly owner-approved batch commands below.
- Resumable: every batch appends to a state file; re-running skips completed URLs.

---

### Task 1: Sitemap discovery

**Files:** Create `scripts/dt-harvest/discover.mjs`, `scripts/dt-harvest/lib/sitemap.mjs`, test `scripts/dt-harvest/lib/sitemap.test.mjs`

**Interfaces:** `parseSitemapXml(xml: string): string[]` (url list), `filterTireProductUrls(urls: string[]): string[]` (product-page pattern only).

- [ ] **Step 1: Failing test** — fixture sitemap XML (index + child) parses to urls; non-product urls (store pages, /tires-101 articles) filtered out; malformed XML returns [] without throwing.
- [ ] **Step 2:** `npx vitest run scripts/dt-harvest/lib/sitemap.test.mjs` -> FAIL
- [ ] **Step 3: Implement** — regex-based `<loc>` extraction (no XML dep), product filter by URL pattern (verify the real pattern in Step 5 and adjust the filter + test fixture to match reality).
- [ ] **Step 4:** PASS
- [ ] **Step 5 (live, free, ~5 requests):** `node scripts/dt-harvest/discover.mjs` fetches the real sitemap chain, writes `scripts/dt-harvest/state/urls.json` `{ discoveredAt, urls: [...] }`, prints the count. Sanity: expect tens of thousands. Commit code + the count in the report file (NOT the url list — too big for git; state/ goes in .gitignore).
- [ ] **Step 6: Commit** — `feat(dt-harvest): sitemap discovery`

### Task 2: JSON-LD product parser (pure)

**Files:** Create `scripts/dt-harvest/lib/parseProduct.mjs`, test `scripts/dt-harvest/lib/parseProduct.test.mjs`

**Interfaces:** `parseTireFromHtml(html: string, sourceUrl: string): TireRow | null` where `TireRow = { gtin, brand, model, size, loadIndex, speedRating, partNumber, imageUrl, sourceUrl, fetchedAt }`.

- [ ] **Step 1: Failing tests** — (a) fixture HTML containing a real-shaped JSON-LD Product block (build the fixture from one live DT page fetched manually during Task 1 Step 5) parses every field; (b) page without JSON-LD -> null; (c) hostile HTML ("ignore previous instructions" inside description) parses fields normally — instruction text is data; (d) size parsing reuses the dash-notation lesson (255/40-17 == 255/40R17).
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** (extract `<script type="application/ld+json">` blocks, JSON.parse each defensively, pick `@type: Product`, map `gtin`/`gtin13`/`gtin12`, brand.name, name -> model+size split via the existing tire-size regex pattern copied from `src/services/ai/tireSpecs.ts`)  - [ ] **Step 4:** PASS  - [ ] **Step 5: Commit** — `feat(dt-harvest): deterministic JSON-LD tire parser`

### Task 3: Poison guard + merge

**Files:** Create `scripts/dt-harvest/lib/merge.mjs`, test `scripts/dt-harvest/lib/merge.test.mjs`

**Interfaces:** `guardRow(row: TireRow, prefixMap: Record<string,string[]>): { ok: true } | { ok: false; reason: string }`; `mergeRows(existing: CorpusRow[], incoming: TireRow[]): { merged: CorpusRow[], added: number, skipped: { row, reason }[] }`.

- [ ] **Step 1: Failing tests** — invalid check digit rejected; brand conflicting with the derived prefix map (`src/services/catalog/derivedPrefixMap.json`) rejected with reason `prefix_conflict`; duplicate GTIN vs an existing row from ANOTHER source: keeps existing, records skip `cross_source_duplicate`; duplicate within discounttire source: higher field-completeness wins; added rows carry `source:"discounttire"` + `current_status:"active_retail"` matching the corpus schema (columns listed in `scripts/tmp-tire-inspect.mjs` output: barcode, brand, model, size, load_index, speed_rating, barcode_type, ...).
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement**  - [ ] **Step 4:** PASS  - [ ] **Step 5: Commit** — `feat(dt-harvest): poison guard (check digit + prefix firewall) and cross-source-safe merge`

### Task 4: Playwright fetcher with block telemetry

**Files:** Create `scripts/dt-harvest/fetchPage.mjs`, test `scripts/dt-harvest/fetchPage.test.mjs` (logic parts only)

**Interfaces:** `fetchProductPage(browserPage, url): Promise<{ status: "ok"|"blocked"|"error"; html?: string }>`; `class BlockRateStop { record(status): void; shouldStop(): boolean }` (rolling window 50, threshold 0.30).

- [ ] **Step 1: Failing test (pure part)** — BlockRateStop: 14 blocked of 50 -> continue; 16 of 50 -> stop; window slides (old blocks age out).
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** — fetcher: `chromium.launch({ headless: true })`, context with realistic UA/viewport/locale/timezone, `page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })`, wait for `script[type="application/ld+json"]` selector (8s), classify: selector found -> ok; 403/429/captcha-marker in title/body -> blocked; else error. Randomized 2000-4000ms delay lives in the batch loop, not here.
- [ ] **Step 4:** PASS (pure parts) — the fetcher itself is proven in Task 5's pilot.
- [ ] **Step 5: Commit** — `feat(dt-harvest): playwright fetcher + rolling block-rate stop`

### Task 5: Pilot batch (live, 100 pages, owner-approved by the spec)

**Files:** Create `scripts/dt-harvest/run-batch.mjs` (the resumable batch driver)

- [ ] **Step 1:** Driver: reads `state/urls.json` + `state/done.json`, takes `--limit=N` urls, fetch -> parse -> guard -> append rows to `state/harvested.jsonl`, telemetry to `state/telemetry.json` (ok/blocked/error counts, block rate, pages/hour). Crash-safe: state written after every page.
- [ ] **Step 2 (live pilot):** `node scripts/dt-harvest/run-batch.mjs --limit=100`. Success gate: block rate <= 30%, >= 60 parsed rows with valid GTINs. If blocked out: write the stop-report and STOP — owner decides fallback (Firecrawl credits or abandon). Do not improvise proxies/stealth plugins beyond the configured context — that is detection-evasion escalation the owner has not ordered.
- [ ] **Step 3:** Report pilot numbers (block rate, rows/page, fields coverage, ETA + disk for full catalog) to the owner BEFORE the full backfill.
- [ ] **Step 4: Commit** — `feat(dt-harvest): resumable batch driver + pilot report`

### Task 6: Corpus merge + rebuild + spot-check

**Files:** Create `scripts/dt-harvest/apply.mjs`

- [ ] **Step 1:** `node scripts/dt-harvest/apply.mjs` — merges `state/harvested.jsonl` through Task 3's guard into `tireKnowledge.generated.json` (backup copy first: `.bak-<date>`), prints added/skipped table, runs `npm run build:knowledge-db`, then spot-checks 20 random new rows via the SQLite lookup (barcode -> row round-trip).
- [ ] **Step 2:** Ladder integration proof: 10 newly-added GTINs through the decode route -> all resolve at rung 1a for $0.
- [ ] **Step 3: Commit** — `feat(dt-harvest): guarded corpus apply + rebuild + round-trip proof` (the generated JSON/DB follow existing repo policy for generated artifacts).

### Task 7: Full backfill (batched background runs)

- [ ] **Step 1:** Run `run-batch.mjs --limit=2000` repeatedly (background tasks, sequential), applying (`apply.mjs`) after each batch. Monitor telemetry between batches; the 30% stop and politeness delays hold throughout. Wall-clock estimate from pilot; report progress to owner at each apply.
- [ ] **Step 2:** Final backfill report: rows added, corpus size before/after, field coverage, block-rate history, $0 spend confirmation.

### Task 8: Weekly top-up job (lower-tier agent)

**Files:** Create `scripts/dt-harvest/weekly.mjs`; register the schedule

- [ ] **Step 1:** `weekly.mjs` = discover (new urls only) + batch (cap 500 pages) + apply + a short report file.
- [ ] **Step 2:** Schedule it via the existing weekly-report machinery pattern (or `/schedule` cloud routine if preferred at execution time), with the run explicitly pinned to a LOWER-TIER model (haiku) agent whose only jobs are: run the script, read telemetry, write the summary, flag anomalies to the owner. It has no authority to change caps, hosts, or guards.
- [ ] **Step 3: Commit** — `feat(dt-harvest): weekly top-up job (haiku-tier runner)`

## Self-review notes

- Owner orders covered: full catalog (T1/T7), Playwright-as-Firecrawl (T4), cheapest possible ($0 API; compute only), max info per tire (T2 field set), lower-tier subagent (T8), grow-own-database goal (T6/T7).
- Safety: allowlist single host; block-rate stop prevents hammering; poison guard keeps corpus truth-source clean (check digit + prefix firewall + cross-source no-overwrite); scraped text treated as data; no AI calls anywhere.
- Explicit non-goal: no stealth/anti-bot escalation beyond a realistic browser context — if DT blocks Playwright, the pipeline stops and reports instead of evading.
