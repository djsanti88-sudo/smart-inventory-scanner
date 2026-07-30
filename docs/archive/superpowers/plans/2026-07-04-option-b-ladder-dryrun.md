# Option B Decode Ladder - 150-Code Dry Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove or kill the Gemini-first -> cheap-fetch-verify -> gpt-5.5 decode ladder on 150 ground-truthed codes BEFORE building it into the app, with zero wrong auto-counts as the hard gate.

**Architecture:** Three production-grade fetch-layer upgrades land in `src/services` (TDD, no app-route changes); a standalone tsx probe script imports those REAL modules plus the real `EvidenceVerifier` and walks the ladder over a curated 150-code fixture; a grader scores every code against its pre-tagged expected outcome; results feed a summary + PDF.

**Tech Stack:** TypeScript (src services + vitest node project), tsx for the probe script, Node fetch, Gemini API (gemini-3.5-flash + google_search), OpenAI Responses API (gpt-5.5 + web_search), Python reportlab for the PDF.

## Global Constraints

- Live-spend HARD CAP for the whole dry run: **$15.00** (owner-authorized 2026-07-04); guard enforced in code from billed usage; only Task 9 spends money.
- No deploys, no pushes, no preview; local branch `feat/option-b-dryrun` off `master`.
- Automated tests NEVER call live providers (mock `fetchImpl` / canned AI responses); live calls happen only in the explicitly authorized Task 9 run.
- API keys read from `.env.local` (strip surrounding quotes!) or system env; never printed, never committed.
- Probe scripts are throwaway: `scripts/tmp-*` naming; fixture + results JSON are keepers.
- Spec: `docs/archive/superpowers/specs/2026-07-04-option-b-ladder-dry-run-design.md` (group sizes, gates, code-type rules live there and are copied into tasks below).
- Prompt v2 (verbatim, used for BOTH providers):
  `Identify the product for barcode {CODE}. Search the web. Return JSON only: {"brand":"","productName":"","specs":"","gtin":"","confidence":0.0,"exactCodeFound":false,"basis":"","sourceUrls":[]}. If you find this exact code in a real page, set exactCodeFound true and confidence to match the evidence. If you cannot, STILL return your single best guess from partial matches, barcode prefix ownership, or similar listings - set exactCodeFound false, confidence 0.4 or less, and say why in basis. Keep it brief. Never leave productName empty if you have any plausible guess.`

---

### Task 1: Branch + broad tiered barcode source pool (`barcodeSources.ts`)

**Files:**
- Create: `src/services/ai/barcodeSources.ts`
- Test: `src/services/ai/barcodeSources.test.ts`

**Interfaces:**
- Produces: `classifyGtin(code: string): "upc_us" | "ean_intl" | "gtin14" | "other"`, `selectBarcodeUrls(code: string, max?: number): string[]` (max defaults 8), `BARCODE_SOURCES` (exported for the trust-rule review). Task 5's probe and Task 2's tests rely on these exact names.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/option-b-dryrun master
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/services/ai/barcodeSources.test.ts
import { describe, it, expect } from "vitest";
import { classifyGtin, selectBarcodeUrls, BARCODE_SOURCES } from "@/services/ai/barcodeSources";

describe("classifyGtin", () => {
  it("classifies 12-digit as US UPC", () => expect(classifyGtin("078742051451".slice(1))).toBe("upc_us"));
  it("classifies 13-digit starting 0 as US UPC", () => expect(classifyGtin("0078742051451".slice(0, 13))).toBe("upc_us"));
  it("classifies 13-digit non-0 prefix as international EAN", () => expect(classifyGtin("3017620422003")).toBe("ean_intl"));
  it("classifies 14-digit as GTIN-14", () => expect(classifyGtin("10019320009355")).toBe("gtin14"));
  it("classifies vendor-style codes as other", () => expect(classifyGtin("DCB205")).toBe("other"));
});

describe("selectBarcodeUrls", () => {
  it("caps at 8 URLs and dedupes", () => {
    const urls = selectBarcodeUrls("3017620422003");
    expect(urls.length).toBeLessThanOrEqual(8);
    expect(new Set(urls).size).toBe(urls.length);
  });
  it("prioritizes international sources for a foreign EAN", () => {
    const urls = selectBarcodeUrls("3017620422003").join(" ");
    expect(urls).toMatch(/ean-search\.org|opengtindb\.org|eandata\.com|openfoodfacts\.org/);
  });
  it("prioritizes US sources for a UPC-A", () => {
    const urls = selectBarcodeUrls("078742051451").join(" ");
    expect(urls).toMatch(/upcitemdb\.com|go-upc\.com|barcodelookup\.com/);
  });
  it("includes GTIN-14-aware sources for a case code", () => {
    const urls = selectBarcodeUrls("10019320009355").join(" ");
    expect(urls).toMatch(/go-upc\.com|upcitemdb\.com|openfoodfacts\.org/);
  });
  it("returns [] for empty code", () => expect(selectBarcodeUrls("")).toEqual([]));
  it("every source in the pool has a host and at least one tier", () => {
    for (const s of BARCODE_SOURCES) {
      expect(s.host.length).toBeGreaterThan(3);
      expect(s.tiers.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/services/ai/barcodeSources.test.ts`
Expected: FAIL - cannot resolve `@/services/ai/barcodeSources`

- [ ] **Step 4: Write the implementation**

```typescript
// src/services/ai/barcodeSources.ts
// Broad tiered pool of LEGITIMATE barcode/product databases (owner: "as broad as possible,
// legit sites only", 2026-07-04). A per-code selector picks the best ~8 by code type so
// breadth never costs latency. Trust rules are unchanged: these URLs are candidate FETCH
// targets; a page only counts when the exact code appears in real page text (EvidenceVerifier),
// and the not-found / recycled-UPC guards in pageFetch apply to every host.

export type SourceTier = "us" | "intl" | "case" | "generic";

export interface BarcodeSource {
  host: string;
  tiers: SourceTier[];
  url: (raw: string, gtin13: string, gtin14: string) => string;
}

export const BARCODE_SOURCES: BarcodeSource[] = [
  { host: "go-upc.com", tiers: ["us", "case", "generic"], url: (raw) => `https://go-upc.com/search?q=${encodeURIComponent(raw)}` },
  { host: "upcitemdb.com", tiers: ["us", "case", "generic"], url: (raw) => `https://www.upcitemdb.com/upc/${encodeURIComponent(raw)}` },
  { host: "barcodelookup.com", tiers: ["us", "generic"], url: (raw) => `https://www.barcodelookup.com/${encodeURIComponent(raw)}` },
  { host: "buycott.com", tiers: ["us"], url: (raw) => `https://www.buycott.com/upc/${encodeURIComponent(raw)}` },
  { host: "barcodesdatabase.org", tiers: ["us", "generic"], url: (_r, g13) => `https://barcodesdatabase.org/barcode/${g13}` },
  { host: "barcodespider.com", tiers: ["us"], url: (raw) => `https://www.barcodespider.com/${encodeURIComponent(raw)}` },
  { host: "ean-search.org", tiers: ["intl", "case", "generic"], url: (_r, g13) => `https://www.ean-search.org/?q=${g13}` },
  { host: "eandata.com", tiers: ["intl"], url: (_r, g13) => `https://eandata.com/feed/?v=3&keycode=&mode=json&find=${g13}` },
  { host: "world.openfoodfacts.org", tiers: ["intl", "us", "case"], url: (_r, g13) => `https://world.openfoodfacts.org/api/v2/product/${g13}.json` },
  { host: "upcdatabase.org", tiers: ["us"], url: (raw) => `https://upcdatabase.org/code/${encodeURIComponent(raw)}` },
  { host: "barcode-list.com", tiers: ["intl"], url: (_r, g13) => `https://barcode-list.com/barcode/EN/Search.htm?barcode=${g13}` },
  { host: "opengtindb.org", tiers: ["intl"], url: (_r, g13) => `https://opengtindb.org/?ean=${g13}&cmd=query&queryid=400000000` },
  { host: "codecheck.info", tiers: ["intl"], url: (_r, g13) => `https://www.codecheck.info/product.search?q=${g13}` },
  { host: "brickseek.com", tiers: ["us"], url: (raw) => `https://brickseek.com/search?q=${encodeURIComponent(raw)}` },
  { host: "gtin.info", tiers: ["generic"], url: (_r, _g13, g14) => `https://gtin.info/check-digit-calculator/?gtin=${g14}` },
];

export function classifyGtin(code: string): "upc_us" | "ean_intl" | "gtin14" | "other" {
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length !== (code ?? "").trim().length) {
    // non-digit characters present -> vendor/part-number shaped
    if (!/^\d+$/.test((code ?? "").trim())) return "other";
  }
  if (d.length === 14) return "gtin14";
  if (d.length === 12) return "upc_us";
  if (d.length === 13) return d.startsWith("0") ? "upc_us" : "ean_intl";
  return "other";
}

const TIER_ORDER: Record<ReturnType<typeof classifyGtin>, SourceTier[]> = {
  upc_us: ["us", "generic", "intl"],
  ean_intl: ["intl", "generic", "us"],
  gtin14: ["case", "generic", "us", "intl"],
  other: ["generic", "us"],
};

export function selectBarcodeUrls(code: string, max = 8): string[] {
  const raw = (code ?? "").trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  if (!digits) return []; // pure vendor codes have no barcode-DB URL; the ladder uses AI-cited URLs instead
  const g13 = digits.padStart(13, "0").slice(-13);
  const g14 = digits.padStart(14, "0").slice(-14);
  const kind = classifyGtin(raw);
  const ordered: string[] = [];
  for (const tier of TIER_ORDER[kind]) {
    for (const s of BARCODE_SOURCES) {
      if (s.tiers.includes(tier)) ordered.push(s.url(raw, g13, g14));
    }
  }
  return [...new Set(ordered)].slice(0, max);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/ai/barcodeSources.test.ts`
Expected: PASS (all cases)

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/barcodeSources.ts src/services/ai/barcodeSources.test.ts
git commit -m "feat(decode): broad tiered barcode source pool with per-code selector"
```

---

### Task 2: ASIN verified-by-page-fetch path (`asinVerify.ts`)

**Files:**
- Create: `src/services/ai/asinVerify.ts`
- Test: `src/services/ai/asinVerify.test.ts`

**Interfaces:**
- Consumes: `FetchImpl`, `fetchPages` from `@/services/ai/pageFetch`; `extractTitleProduct` from `@/services/ai/pageFetch`.
- Produces: `looksLikeAsin(code: string): boolean`, `verifyAsinPage(asin: string, deps?: { fetchImpl?: FetchImpl; signal?: AbortSignal }): Promise<{ verified: boolean; productName: string; brand: string; url: string; reason: string }>`. Task 5's ladder calls `verifyAsinPage` for ASIN-shaped codes.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/ai/asinVerify.test.ts
import { describe, it, expect } from "vitest";
import { looksLikeAsin, isRealAmazonProductPage, verifyAsinPage } from "@/services/ai/asinVerify";
import type { FetchImpl } from "@/services/ai/pageFetch";

const PRODUCT_HTML = `<html><head><meta property="og:title" content="Echo Dot (5th Gen) | Smart speaker"/><title>Echo Dot</title></head><body><span id="productTitle">Echo Dot (5th Gen)</span></body></html>`;
const ROBOT_HTML = `<html><body>Robot Check - Enter the characters you see below. api-services-support@amazon.com</body></html>`;

const fakeFetch = (status: number, body: string): FetchImpl => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

describe("looksLikeAsin", () => {
  it("accepts B0-prefixed 10-char ASINs", () => expect(looksLikeAsin("B0BCH8W3RD")).toBe(true));
  it("rejects UPCs", () => expect(looksLikeAsin("078742051451")).toBe(false));
  it("rejects FNSKUs (X00...)", () => expect(looksLikeAsin("X004ABCDEF")).toBe(false));
});

describe("isRealAmazonProductPage", () => {
  it("accepts a real product page", () => expect(isRealAmazonProductPage(PRODUCT_HTML)).toBe(true));
  it("rejects a robot-check page", () => expect(isRealAmazonProductPage(ROBOT_HTML)).toBe(false));
  it("rejects empty html", () => expect(isRealAmazonProductPage("")).toBe(false));
});

describe("verifyAsinPage", () => {
  it("verifies when the dp page is a real product page", async () => {
    const r = await verifyAsinPage("B0BCH8W3RD", { fetchImpl: fakeFetch(200, PRODUCT_HTML) });
    expect(r.verified).toBe(true);
    expect(r.productName).toContain("Echo Dot");
    expect(r.url).toBe("https://www.amazon.com/dp/B0BCH8W3RD");
  });
  it("does NOT verify on robot-check", async () => {
    const r = await verifyAsinPage("B0BCH8W3RD", { fetchImpl: fakeFetch(200, ROBOT_HTML) });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("blocked");
  });
  it("does NOT verify on 404", async () => {
    const r = await verifyAsinPage("B0BCH8W3RD", { fetchImpl: fakeFetch(404, "") });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("no_page");
  });
  it("rejects non-ASIN input without fetching", async () => {
    const r = await verifyAsinPage("X004ABCDEF", { fetchImpl: fakeFetch(200, PRODUCT_HTML) });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("not_asin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/ai/asinVerify.test.ts`
Expected: FAIL - cannot resolve `@/services/ai/asinVerify`

- [ ] **Step 3: Write the implementation**

```typescript
// src/services/ai/asinVerify.ts
import { type FetchImpl, fetchPages, extractTitleProduct } from "@/services/ai/pageFetch";

// OWNER RULE (2026-07-04): an ASIN whose amazon.com/dp/<ASIN> page loads as a REAL product page
// is deterministic identity proof -> verified. The code appearing in a URL alone proves nothing
// (URLs are constructible from any code); the page must actually load as a product page.
// FNSKUs (X00...) are NOT ASINs and are publicly unverifiable by Amazon's design - never here.

const ASIN_RE = /^B0[0-9A-Z]{8}$/i;

export function looksLikeAsin(code: string): boolean {
  return ASIN_RE.test((code ?? "").trim());
}

const BLOCKED_RE = /robot check|captcha|api-services-support@amazon|automated access/i;

export function isRealAmazonProductPage(html: string): boolean {
  if (!html) return false;
  if (BLOCKED_RE.test(html)) return false;
  return /id="productTitle"/i.test(html) || /<meta[^>]+property=["']og:title["']/i.test(html);
}

export async function verifyAsinPage(
  asin: string,
  deps?: { fetchImpl?: FetchImpl; signal?: AbortSignal },
): Promise<{ verified: boolean; productName: string; brand: string; url: string; reason: string }> {
  const clean = (asin ?? "").trim().toUpperCase();
  const url = `https://www.amazon.com/dp/${clean}`;
  if (!looksLikeAsin(clean)) return { verified: false, productName: "", brand: "", url, reason: "not_asin" };

  const pages = await fetchPages([url], { fetchImpl: deps?.fetchImpl, signal: deps?.signal, timeoutMs: 8000 });
  if (pages.length === 0) return { verified: false, productName: "", brand: "", url, reason: "no_page" };
  const page = pages[0];
  if (!isRealAmazonProductPage(page.html)) return { verified: false, productName: "", brand: "", url, reason: "blocked" };

  const t = extractTitleProduct(page.html);
  if (!t.productName) return { verified: false, productName: "", brand: t.brand, url, reason: "no_title" };
  return { verified: true, productName: t.productName, brand: t.brand, url, reason: "product_page" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/ai/asinVerify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/asinVerify.ts src/services/ai/asinVerify.test.ts
git commit -m "feat(decode): ASIN verified-by-page-fetch path (owner rule 2026-07-04)"
```

---

### Task 3: Per-host 429/403 cooldown in `pageFetch.ts`

**Files:**
- Modify: `src/services/ai/pageFetch.ts` (fetchOne + fetchPages, ~lines 100-155)
- Test: `src/services/ai/pageFetch.cooldown.test.ts`

**Interfaces:**
- Produces: `hostOnCooldown(url: string, now?: number): boolean`, `setHostCooldown(url: string, now?: number): void`, `resetHostCooldowns(): void` exported from `@/services/ai/pageFetch`. `fetchPages` silently skips URLs whose host is cooling down; `fetchOne` sets the cooldown after its final rate-limited attempt.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/ai/pageFetch.cooldown.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { fetchPages, hostOnCooldown, setHostCooldown, resetHostCooldowns, type FetchImpl } from "@/services/ai/pageFetch";

beforeEach(() => resetHostCooldowns());

describe("host cooldown", () => {
  it("is set manually and expires after 10 minutes", () => {
    const t0 = 1_000_000;
    setHostCooldown("https://go-upc.com/search?q=1", t0);
    expect(hostOnCooldown("https://go-upc.com/other", t0 + 1)).toBe(true);
    expect(hostOnCooldown("https://go-upc.com/other", t0 + 10 * 60_000 + 1)).toBe(false);
    expect(hostOnCooldown("https://upcitemdb.com/upc/1", t0 + 1)).toBe(false);
  });

  it("fetchPages skips cooled-down hosts without calling fetch", async () => {
    const calls: string[] = [];
    const impl: FetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => "<html>x</html>" }; };
    setHostCooldown("https://go-upc.com/x");
    await fetchPages(["https://go-upc.com/search?q=1", "https://upcitemdb.com/upc/1"], { fetchImpl: impl });
    expect(calls).toEqual(["https://upcitemdb.com/upc/1"]);
  });

  it("a doubly rate-limited host lands on cooldown", async () => {
    const impl: FetchImpl = async () => ({ ok: false, status: 429, text: async () => "" });
    await fetchPages(["https://go-upc.com/search?q=1"], { fetchImpl: impl, backoffMs: 1 });
    expect(hostOnCooldown("https://go-upc.com/anything")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/ai/pageFetch.cooldown.test.ts`
Expected: FAIL - `hostOnCooldown` is not exported

- [ ] **Step 3: Implement the cooldown**

In `src/services/ai/pageFetch.ts`, add above `fetchOne`:

```typescript
// Per-host politeness memory: after a host answers 429/403 twice in one fetch, skip that host
// for 10 minutes instead of re-hitting it on every scan. In-memory (per server instance) only.
const HOST_COOLDOWN_MS = 10 * 60_000;
const hostCooldownUntil = new Map<string, number>();

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function hostOnCooldown(url: string, now: number = Date.now()): boolean {
  const until = hostCooldownUntil.get(hostOf(url));
  return until !== undefined && now < until;
}

export function setHostCooldown(url: string, now: number = Date.now()): void {
  hostCooldownUntil.set(hostOf(url), now + HOST_COOLDOWN_MS);
}

export function resetHostCooldowns(): void {
  hostCooldownUntil.clear();
}
```

In `fetchOne`, change the rate-limit branch (currently `return null; // rate-limited -> skip politely`) to:

```typescript
        if (attempt === 0) {
          await sleep(opts.backoffMs, opts.signal); // one short backoff, then give up
          continue;
        }
        setHostCooldown(url); // second 429/403 -> cool this host down for 10 minutes
        return null; // rate-limited -> skip politely
```

In `fetchPages`, filter before mapping (and same in `fetchUntilCodePage`'s caller `enrichWithPageFetch` via its `urls` const — apply the filter inside `fetchPages` and at the top of `fetchUntilCodePage`):

```typescript
  const live = urls.filter((u) => !hostOnCooldown(u));
  const settled = await Promise.allSettled(live.map((u) => fetchOne(u, fetchImpl, opts)));
```

and at the top of `fetchUntilCodePage`:

```typescript
  const liveUrls = urls.filter((u) => !hostOnCooldown(u));
```
(using `liveUrls` in place of `urls` in its `.map`).

- [ ] **Step 4: Run the new test AND the existing pageFetch suite**

Run: `npx vitest run src/services/ai/pageFetch.cooldown.test.ts src/services/ai/pageFetch.test.ts src/services/ai/verifyCodeOnPage.test.ts`
Expected: ALL PASS (no regression in the existing fetch behavior)

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/pageFetch.ts src/services/ai/pageFetch.cooldown.test.ts
git commit -m "feat(decode): per-host 429/403 cooldown in page fetch"
```

---

### Task 4: Curation samplers (tire corpus + retail DB) - candidate lists only, no spend

**Files:**
- Create: `scripts/tmp-dryrun-sample-tires.mjs`
- Create: `scripts/tmp-dryrun-sample-retail.mjs`
- Output (not committed until Task 5 verifies): `scripts/dryrun-candidates-tires.json`, `scripts/dryrun-candidates-retail.json`

**Interfaces:**
- Produces: candidate JSON arrays `[{ code, truth, source }]` consumed by Task 5's manual curation. Both scripts are discovery-based (they inspect the data shape first) so they adapt to the actual corpus/DB schema.

- [ ] **Step 1: Write the tire-corpus sampler**

```javascript
// scripts/tmp-dryrun-sample-tires.mjs
// Samples tire barcodes + part numbers WITH known truth from the local tire-knowledge data.
// Discovery-based: finds JSON/CSV files under data/tire-knowledge, detects barcode/part/name
// fields, prints 40 diverse candidates (we keep 20 after manual verification).
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../data/tire-knowledge", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(json|csv|ndjson)$/i.test(e) && statSync(p).size > 200) files.push(p);
  }
})(ROOT);
console.log("data files found:", files.length);

const CODE_KEYS = ["barcode", "upc", "ean", "gtin", "code"];
const PART_KEYS = ["partNumber", "part_number", "mpn", "sku", "part"];
const NAME_KEYS = ["name", "productName", "product_name", "title", "model"];
const pick = (row, keys) => { for (const k of keys) { const v = row?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); } return ""; };

const out = [];
for (const f of files) {
  let rows = [];
  const text = readFileSync(f, "utf8");
  try { const j = JSON.parse(text); rows = Array.isArray(j) ? j : Object.values(j).find(Array.isArray) ?? []; }
  catch { /* csv/ndjson: take first 200 lines as ndjson attempts */ 
    rows = text.split(/\r?\n/).slice(0, 200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  for (const row of rows) {
    const code = pick(row, CODE_KEYS);
    const part = pick(row, PART_KEYS);
    const name = pick(row, NAME_KEYS);
    if (name && (code || part)) out.push({ code: code || part, kind: code ? "tire_barcode" : "tire_part", truth: name, source: f.split(/[\\/]/).slice(-2).join("/") });
    if (out.length >= 400) break;
  }
  if (out.length >= 400) break;
}
// diversity: unique by code, alternate barcode/part, spread across brands
const seen = new Set();
const barcodes = out.filter((r) => r.kind === "tire_barcode" && !seen.has(r.code) && seen.add(r.code));
const parts = out.filter((r) => r.kind === "tire_part" && !seen.has(r.code) && seen.add(r.code));
const every = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
const sample = [...every(barcodes, 25), ...every(parts, 15)];
writeFileSync(new URL("./dryrun-candidates-tires.json", import.meta.url), JSON.stringify(sample, null, 2));
console.log(`wrote ${sample.length} tire candidates (barcodes ${Math.min(25, barcodes.length)}, parts ${Math.min(15, parts.length)})`);
```

- [ ] **Step 2: Run it**

Run: `node scripts/tmp-dryrun-sample-tires.mjs`
Expected: `wrote N tire candidates` with N >= 30. If the corpus layout defeats discovery (0 rows), inspect `data/tire-knowledge` manually with Glob/Read and adjust the field lists — do not invent codes.

- [ ] **Step 3: Write the retail-DB sampler**

```javascript
// scripts/tmp-dryrun-sample-retail.mjs
// Samples UPC/EAN codes WITH names from the Turso retail knowledge DB (schema-discovering).
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
const client = createClient({ url: get("TURSO_DATABASE_URL"), authToken: get("TURSO_AUTH_TOKEN") });

const tables = await client.execute(`SELECT name FROM sqlite_master WHERE type='table'`);
console.log("tables:", tables.rows.map((r) => r.name).join(", "));
// find a table with a barcode-ish and a name-ish column
let target = null;
for (const t of tables.rows.map((r) => String(r.name))) {
  const cols = (await client.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
  const codeCol = cols.find((c) => /barcode|upc|ean|gtin|^code$/i.test(c));
  const nameCol = cols.find((c) => /product_name|^name$|title/i.test(c));
  const brandCol = cols.find((c) => /brand/i.test(c)) ?? null;
  if (codeCol && nameCol) { target = { t, codeCol, nameCol, brandCol }; break; }
}
if (!target) { console.error("no suitable table found - inspect schema manually"); process.exit(1); }
console.log("using", JSON.stringify(target));

// 45 US UPCs + 25 foreign EANs (prefix not 0/1), random-ish spread, we keep ~35+12 after checks
const us = await client.execute(`SELECT ${target.codeCol} AS code, ${target.nameCol} AS name${target.brandCol ? `, ${target.brandCol} AS brand` : ""} FROM ${target.t} WHERE length(${target.codeCol}) IN (12,13) AND substr(${target.codeCol},1,1) IN ('0','1') AND ${target.nameCol} != '' ORDER BY rowid % 9973 LIMIT 45`);
const intl = await client.execute(`SELECT ${target.codeCol} AS code, ${target.nameCol} AS name${target.brandCol ? `, ${target.brandCol} AS brand` : ""} FROM ${target.t} WHERE length(${target.codeCol}) = 13 AND substr(${target.codeCol},1,1) NOT IN ('0','1') AND ${target.nameCol} != '' ORDER BY rowid % 7919 LIMIT 25`);
const rows = [...us.rows, ...intl.rows].map((r) => ({ code: String(r.code), truth: `${r.brand ? r.brand + " " : ""}${r.name}`.trim(), source: `turso:${target.t}` }));
writeFileSync(new URL("./dryrun-candidates-retail.json", import.meta.url), JSON.stringify(rows, null, 2));
console.log(`wrote ${rows.length} retail candidates (${us.rows.length} US, ${intl.rows.length} intl)`);
```

- [ ] **Step 4: Run it**

Run: `node scripts/tmp-dryrun-sample-retail.mjs`
Expected: `wrote ~70 retail candidates`. IMPORTANT: these codes exist in our retail DB layer, so in production they'd resolve free before AI - they are here to test the LADDER itself, and the report must say so.

- [ ] **Step 5: Commit the samplers (not the candidate outputs yet)**

```bash
git add scripts/tmp-dryrun-sample-tires.mjs scripts/tmp-dryrun-sample-retail.mjs
git commit -m "chore(dryrun): candidate samplers for tire corpus + retail DB"
```

---

### Task 5: Curate + verify the 150-code fixture

**Files:**
- Create: `e2e/fixtures/dryrun-codes.json`
- Test: `e2e/fixtures/dryrun-codes.test.ts` (vitest node project picks up `*.test.ts`; if the vitest config excludes `e2e/`, put the test at `src/services/dryrunFixture.test.ts` reading the JSON via path)

**Interfaces:**
- Produces: fixture rows `{ code: string, codeType: "upc"|"ean"|"gtin14"|"tire_barcode"|"part_number"|"asin"|"fnsku"|"canary", truth: string, expected: "verified-ok"|"suggest-only"|"must-refuse", source: string, group: string }`. Task 6's probe and Task 8's grader consume exactly these fields.

**Curation protocol (the "hard work" — executor does ALL of it, owner provides nothing):**
- Groups and sizes from the spec: owner21 / canaries10 / tires20 / partNumbers25 / asin8 / fnsku7 / upcEan35 / case12 / obscure12 = 150.
- Owner 21: copy from `e2e/fixtures/owner-problem-codes.json`; row `00016000179998` truth = "DISPUTED: fixture says Cheerios Veggie Blends Family Size; 8 models across 3 providers say Mott's Fruit Flavored Snacks Family Pack" and expected = `suggest-only` until the owner checks the physical product.
- Canaries 10: construct 4 nonexistent-but-checksum-valid UPCs (compute the check digit over invented bodies like `749000000001x`), 3 invented part numbers (`ZQX-99417-B` style), 3 invented FNSKUs (`X00ZZZ9ZZ9`). expected = `must-refuse` for all.
- Tires 20: pick from `scripts/dryrun-candidates-tires.json`; for each kept row, verify truth against a second source (WebSearch the code/part; manufacturer or major-retailer hit required); prefer a mix of brands + ~7 part numbers.
- Part numbers 25: curate from official manufacturer catalogs via WebSearch (starting candidates: DeWalt DCB205 battery, Milwaukee 48-11-1852, Makita BL1850B, Ryobi P108, Wix 51348, Fram PH7317, Purolator PL14610, Motorcraft FL-820-S, ACDelco PF63E, K&N HP-1002, Bosch 3330, NGK 6619 / LFR6AIX-11, Champion RC12YC, Gates K060841, Dorman 555-070, Moen 1225 cartridge, Kohler GP1043211, 3M 2097 filter, Andersen 9134844, Chamberlain 041A5273-1). Each row: truth from the manufacturer page + one retailer corroboration. expected = `suggest-only` (never public auto-count).
- ASIN 8: pick stable, popular Amazon listings across categories; verify each `amazon.com/dp/<ASIN>` loads a product page TODAY (WebFetch); truth = that page title. expected = `verified-ok` (new owner rule).
- FNSKU 7: source from repo history (`proof-archive/`, git log, e2e fixtures mention an X004 NatureBell) + public seller-forum/blog label photos found via WebSearch; truth = the product shown alongside the label; mark `source` with the URL. expected = `suggest-only`.
- UPC/EAN 35: from `scripts/dryrun-candidates-retail.json` — keep 23 US + 12 foreign; spot-check every 5th row via WebSearch (name matches an independent site). expected = `verified-ok`.
- Case codes 12: build GTIN-14s from known products (e.g. the fixture's `10019320009355` pattern): take 12 verified UPCs, prepend packaging indicator `1`, recompute the check digit, then WebSearch each resulting GTIN-14 - KEEP only those with at least one real reference (foodservice/wholesale listings); truth = "case pack of <product>". Codes with no public reference get expected = `suggest-only` (finding nothing is correct behavior).
- Obscure 12: club/store-brand items (Member's Mark, Kirkland, great-value seasonal, regional brands) curated via WebSearch with 2-source truth. expected = mixed (`verified-ok` if the code is clearly public on trusted sites, else `suggest-only`).
- ANY code whose truth cannot be defended with the above protocol is REPLACED, not guessed.

- [ ] **Step 1: Write the failing fixture-validation test**

```typescript
// src/services/dryrunFixture.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rows = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/dryrun-codes.json"), "utf8")).codes as Array<{
  code: string; codeType: string; truth: string; expected: string; source: string; group: string;
}>;

const GROUPS: Record<string, number> = { owner: 21, canary: 10, tire: 20, part: 25, asin: 8, fnsku: 7, upcEan: 35, case: 12, obscure: 12 };

describe("dryrun fixture", () => {
  it("has exactly 150 rows in the agreed group sizes", () => {
    expect(rows.length).toBe(150);
    for (const [g, n] of Object.entries(GROUPS)) {
      expect(rows.filter((r) => r.group === g).length, `group ${g}`).toBe(n);
    }
  });
  it("has no duplicate codes", () => expect(new Set(rows.map((r) => r.code)).size).toBe(150));
  it("every row has code, truth, source and a legal expected value", () => {
    for (const r of rows) {
      expect(r.code.trim().length).toBeGreaterThan(3);
      expect(r.truth.trim().length).toBeGreaterThan(3);
      expect(r.source.trim().length).toBeGreaterThan(2);
      expect(["verified-ok", "suggest-only", "must-refuse"]).toContain(r.expected);
    }
  });
  it("all canaries must-refuse; all FNSKU/part suggest-only; all ASIN verified-ok", () => {
    expect(rows.filter((r) => r.group === "canary").every((r) => r.expected === "must-refuse")).toBe(true);
    expect(rows.filter((r) => r.group === "fnsku" || r.group === "part").every((r) => r.expected === "suggest-only")).toBe(true);
    expect(rows.filter((r) => r.group === "asin").every((r) => r.expected === "verified-ok")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** (`npx vitest run src/services/dryrunFixture.test.ts` -> FAIL, file missing)

- [ ] **Step 3: Curate the fixture per the protocol above** — this is research work (WebSearch/WebFetch per row), expect it to be the longest step of the plan. Build `e2e/fixtures/dryrun-codes.json` as `{ "_comment": "...", "codes": [ ...150 rows... ] }`.

- [ ] **Step 4: Run the validation test until it passes** (`npx vitest run src/services/dryrunFixture.test.ts` -> PASS)

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/dryrun-codes.json src/services/dryrunFixture.test.ts scripts/dryrun-candidates-tires.json scripts/dryrun-candidates-retail.json
git commit -m "feat(dryrun): 150-code ground-truthed fixture across 9 groups"
```

---

### Task 6: The ladder probe script (mock-mode self-test, no spend)

**Files:**
- Create: `scripts/tmp-ladder-dryrun.mts` (tsx; imports REAL src modules via relative paths)

**Interfaces:**
- Consumes: `enrichWithPageFetch`, `selectBarcodeUrls`, `verifyAsinPage`, `looksLikeAsin`, `verifyEvidence`, `crossCheck`, `detectCodeType` (from `../src/services/...`); prompt v2 from Global Constraints.
- Produces: `scripts/tmp-ladder-dryrun-results.json` `{ spent, rows: [{ code, group, expected, stage1..stage3, outcome: "verified"|"suggested"|"refused", match: boolean, secs, cost }] }`. Task 8's grader reads exactly this shape.

- [ ] **Step 1: Write the probe with a `LADDER_MOCK=1` self-test mode**

```typescript
// scripts/tmp-ladder-dryrun.mts
// TEMP dry-run probe (spec 2026-07-04). Run modes:
//   LADDER_MOCK=1 npx tsx scripts/tmp-ladder-dryrun.mts   -> canned AI + fetch, 3 inline codes, asserts outcomes, $0
//   npx tsx scripts/tmp-ladder-dryrun.mts                  -> LIVE, $15 hard cap (Task 9 only, owner-authorized)
import { readFileSync, writeFileSync } from "node:fs";
import { enrichWithPageFetch, type FetchImpl } from "../src/services/ai/pageFetch";
import { selectBarcodeUrls } from "../src/services/ai/barcodeSources";
import { verifyAsinPage, looksLikeAsin } from "../src/services/ai/asinVerify";
import { crossCheck } from "../src/services/ai/crossCheckEngine";
import { detectCodeType } from "../src/services/codeType";   // adjust: grep 'export function detectCodeType' for the real module
import { normalizeResult } from "../src/services/ai/provider";

const BUDGET_USD = 15.0;
const MOCK = process.env.LADDER_MOCK === "1";
const PROMPT = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. Return JSON only: {"brand":"","productName":"","specs":"","gtin":"","confidence":0.0,"exactCodeFound":false,"basis":"","sourceUrls":[]}. If you find this exact code in a real page, set exactCodeFound true and confidence to match the evidence. If you cannot, STILL return your single best guess from partial matches, barcode prefix ownership, or similar listings - set exactCodeFound false, confidence 0.4 or less, and say why in basis. Keep it brief. Never leave productName empty if you have any plausible guess.`;

// --- keys (never printed) ---
const env = (() => { try { return readFileSync(new URL("../.env.local", import.meta.url), "utf8"); } catch { return ""; } })();
const keyOf = (name: string) => env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || process.env[name] || "";
const GEMINI_KEY = keyOf("GEMINI_API_KEY");
const OPENAI_KEY = keyOf("OPENAI_API_KEY");

let spent = 0;
type AiGuess = { brand: string; productName: string; confidence: number; exactCodeFound: boolean; sourceUrls: string[]; basis: string; cost: number; secs: number; error?: string };

function parseGuess(text: string): Omit<AiGuess, "cost" | "secs"> {
  let p: Record<string, unknown> = {};
  try { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s !== -1 && e > s) p = JSON.parse(text.slice(s, e + 1)); } catch { /* raw */ }
  return {
    brand: String(p.brand ?? ""), productName: String(p.productName ?? ""),
    confidence: Number(p.confidence ?? 0), exactCodeFound: Boolean(p.exactCodeFound),
    sourceUrls: Array.isArray(p.sourceUrls) ? p.sourceUrls.map(String) : [], basis: String(p.basis ?? ""),
  };
}

async function geminiGuess(code: string): Promise<AiGuess> {
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT(code) }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2, maxOutputTokens: 3000, thinkingConfig: { thinkingLevel: "low" } } }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!res.ok) return { brand: "", productName: "", confidence: 0, exactCodeFound: false, sourceUrls: [], basis: "", cost: 0, secs: (Date.now() - t0) / 1000, error: `gemini ${res.status}` };
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p?.text ?? "").join("\n");
  const urls = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: { web?: { uri?: string } }) => c?.web?.uri).filter(Boolean);
  const u = data?.usageMetadata ?? {};
  const cost = ((u.promptTokenCount ?? 0) / 1e6) * 1.5 + (((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6) * 9 + ((cand?.groundingMetadata?.webSearchQueries ?? []).length) * 0.014;
  const g = parseGuess(text);
  return { ...g, sourceUrls: [...new Set([...g.sourceUrls, ...urls])], cost, secs: (Date.now() - t0) / 1000 };
}

async function gpt55Guess(code: string): Promise<AiGuess> {
  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: "gpt-5.5", input: PROMPT(code), tools: [{ type: "web_search", search_context_size: "low" }], reasoning: { effort: "low" }, max_output_tokens: 6000, max_tool_calls: 5 }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!res.ok) return { brand: "", productName: "", confidence: 0, exactCodeFound: false, sourceUrls: [], basis: "", cost: 0, secs: (Date.now() - t0) / 1000, error: `openai ${res.status}` };
  let text = ""; let searches = 0; const urls: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type === "web_search_call") searches++;
    if (item?.type !== "message") continue;
    for (const part of item?.content ?? []) if (part?.type === "output_text") { text += part.text ?? ""; for (const a of part.annotations ?? []) if (a?.type === "url_citation" && a.url) urls.push(a.url); }
  }
  const cost = ((data?.usage?.input_tokens ?? 0) / 1e6) * 5 + ((data?.usage?.output_tokens ?? 0) / 1e6) * 30 + searches * 0.01;
  const g = parseGuess(text);
  return { ...g, sourceUrls: [...new Set([...g.sourceUrls, ...urls])], cost, secs: (Date.now() - t0) / 1000 };
}

// --- mock layer (LADDER_MOCK=1): canned guesses + fetch pages; asserts the ladder wiring ---
const MOCK_CODES = [
  { code: "078742028477", group: "upcEan", expected: "verified-ok", truth: "Member's Mark Purified Water 40 Pack" },
  { code: "X00MOCK111", group: "fnsku", expected: "suggest-only", truth: "Mock FNSKU product" },
  { code: "749000000010", group: "canary", expected: "must-refuse", truth: "does not exist" },
];
const mockGemini = async (code: string): Promise<AiGuess> => code === "078742028477"
  ? { brand: "Member's Mark", productName: "Purified Water 40 Pack", confidence: 0.95, exactCodeFound: true, sourceUrls: ["https://www.upcitemdb.com/upc/78742028477"], basis: "", cost: 0, secs: 0.1 }
  : code === "X00MOCK111"
    ? { brand: "MockCo", productName: "Mock FNSKU product", confidence: 0.3, exactCodeFound: false, sourceUrls: [], basis: "fnsku not public", cost: 0, secs: 0.1 }
    : { brand: "", productName: "Imaginary Thing", confidence: 0.2, exactCodeFound: false, sourceUrls: [], basis: "nothing found", cost: 0, secs: 0.1 };
const mockFetchImpl: FetchImpl = async (url) => ({
  ok: url.includes("78742028477"), status: url.includes("78742028477") ? 200 : 404,
  text: async () => url.includes("78742028477")
    ? `<html><head><title>Member's Mark Purified Water 40 pack 16.9 oz | UPCitemdb</title></head><body>UPC 078742028477 Member's Mark Purified Water</body></html>`
    : "",
});

// --- the ladder ---
async function runLadder(row: { code: string; group: string; expected: string; truth: string }) {
  const t0 = Date.now();
  const code = row.code;
  const codeType = detectCodeType(code);
  let cost = 0;
  const stage: Record<string, unknown> = {};

  // ASIN short-circuit (owner rule): dp page fetch decides
  if (looksLikeAsin(code)) {
    const a = await verifyAsinPage(code, MOCK ? { fetchImpl: mockFetchImpl } : undefined);
    stage.asin = a;
    const outcome = a.verified ? "verified" : "suggested";
    return { ...row, codeType, stage, outcome, cost, secs: (Date.now() - t0) / 1000 };
  }

  // Stage 1: Gemini guess
  const g = MOCK ? await mockGemini(code) : await geminiGuess(code);
  cost += g.cost; stage.gemini = g;

  // Stage 2: cheap verification - Gemini-cited URLs + tiered barcode DB URLs, real fetch machinery
  const enrich = await enrichWithPageFetch({
    code, codeType,
    extraUrls: g.sourceUrls.slice(0, 4),
    maxPages: 8,
    fetchImpl: MOCK ? mockFetchImpl : undefined,
    extraUrlsFirst: undefined as never, // (not a real param - placeholder comment removed in impl)
  } as Parameters<typeof enrichWithPageFetch>[0]);
  stage.fetch = { verified: enrich.evidence.verified, strength: enrich.evidence.strength, pages: enrich.pageCount, product: enrich.result?.productName ?? "" };
  // Hypothesis corroboration: fetched product agrees with Gemini's guess?
  const agree = enrich.result && g.productName ? crossCheck(enrich.result, normalizeResult({ productName: g.productName, brand: g.brand })).decision === "agree" : false;
  stage.agreeWithGemini = agree;

  if (enrich.result && enrich.evidence.verified && ["upc", "ean", "gtin", "gtin14", "barcode"].includes(String(codeType))) {
    return { ...row, codeType, stage, outcome: "verified", product: enrich.result.productName, cost, secs: (Date.now() - t0) / 1000 };
  }

  // Stage 3: gpt-5.5 boost, only when cheap verify failed
  const b = MOCK ? { ...(await mockGemini(code)), cost: 0 } : await gpt55Guess(code);
  cost += b.cost; stage.gpt55 = b;
  if (b.sourceUrls.length > 0 && !MOCK) {
    const enrich2 = await enrichWithPageFetch({ code, codeType, extraUrls: b.sourceUrls.slice(0, 6), maxPages: 6 });
    stage.fetch2 = { verified: enrich2.evidence.verified, strength: enrich2.evidence.strength, product: enrich2.result?.productName ?? "" };
    if (enrich2.result && enrich2.evidence.verified && ["upc", "ean", "gtin", "gtin14", "barcode"].includes(String(codeType))) {
      return { ...row, codeType, stage, outcome: "verified", product: enrich2.result.productName, cost, secs: (Date.now() - t0) / 1000 };
    }
  }

  // No verification anywhere -> suggested (best guess attached) or refused (no guess at all)
  const best = b.productName || g.productName;
  return { ...row, codeType, stage, outcome: best ? "suggested" : "refused", product: best, guessConfidence: Math.min(b.confidence || 0, 0.4) || Math.min(g.confidence || 0, 0.4), cost, secs: (Date.now() - t0) / 1000 };
}

// --- main ---
const rows = MOCK ? MOCK_CODES : JSON.parse(readFileSync(new URL("../e2e/fixtures/dryrun-codes.json", import.meta.url), "utf8")).codes;
const WORST_PER_CODE = 0.25; // gemini ~$0.07 worst + 5.5 ~$0.18 worst with caps
const results: unknown[] = [];
for (const row of rows) {
  if (!MOCK && spent + WORST_PER_CODE > BUDGET_USD) { console.log(`BUDGET GUARD: stopping at ${row.code} ($${spent.toFixed(2)} spent)`); break; }
  const r = await runLadder(row);
  spent += r.cost;
  results.push(r);
  console.log(`[${r.group}] ${r.code} -> ${r.outcome}${r.product ? ` "${r.product}"` : ""} | expected ${r.expected} | $${r.cost.toFixed(3)} | ${r.secs.toFixed(1)}s | spent $${spent.toFixed(2)}`);
}
writeFileSync(new URL(MOCK ? "./tmp-ladder-mock-results.json" : "./tmp-ladder-dryrun-results.json", import.meta.url), JSON.stringify({ spent, results }, null, 2));

if (MOCK) {
  const by = Object.fromEntries((results as Array<{ code: string; outcome: string }>).map((r) => [r.code, r.outcome]));
  const ok = by["078742028477"] === "verified" && by["X00MOCK111"] === "suggested" && by["749000000010"] !== "verified";
  console.log(ok ? "MOCK SELF-TEST PASS" : `MOCK SELF-TEST FAIL: ${JSON.stringify(by)}`);
  process.exit(ok ? 0 : 1);
}
console.log(`\nDONE. Spend $${spent.toFixed(2)} of $${BUDGET_USD}.`);
```

Note: before running, `grep -r "export function detectCodeType" src/` and fix the import path to the real module; remove the placeholder-comment line in the `enrichWithPageFetch` call (pass only real params: `code, codeType, extraUrls, maxPages, fetchImpl`).

- [ ] **Step 2: Run the mock self-test (zero spend)**

Run: `LADDER_MOCK=1 npx tsx scripts/tmp-ladder-dryrun.mts` (PowerShell: `$env:LADDER_MOCK='1'; npx tsx scripts/tmp-ladder-dryrun.mts`)
Expected: `MOCK SELF-TEST PASS`, exit 0. The verified path, suggest path, and refuse path all route correctly through the REAL enrichWithPageFetch/EvidenceVerifier.

- [ ] **Step 3: Commit**

```bash
git add scripts/tmp-ladder-dryrun.mts
git commit -m "feat(dryrun): ladder probe with mock self-test and $15 budget guard"
```

---

### Task 7: Full unit-suite regression check (no spend)

**Files:** none new.

- [ ] **Step 1: Run the whole vitest suite**

Run: `npm run test`
Expected: ALL PASS except the known-flaky `cloudDrainRace.store.test.ts` (timing-flaky under full parallel load only; if it fails, re-run isolated: `npx vitest run src/stores/cloudDrainRace.store.test.ts` -> PASS). The three new-module suites and the existing pageFetch/evidence suites must pass - the fetch upgrades must not regress the current decode path.

- [ ] **Step 2: Commit any fixes** (only if a genuine regression surfaced; fix before proceeding)

---

### Task 8: LIVE dry run ($15 cap - the only spending task)

**Files:**
- Output: `scripts/tmp-ladder-dryrun-results.json`

- [ ] **Step 1: Re-verify keys are loadable (no spend)**: `node -e "const fs=require('fs');const e=fs.readFileSync('.env.local','utf8');console.log('gemini', /^GEMINI_API_KEY=.+$/m.test(e), 'openai', /^OPENAI_API_KEY=.+$/m.test(e))"` -> `gemini true openai true`

- [ ] **Step 2: Launch the live run in the background**

Run: `npx tsx scripts/tmp-ladder-dryrun.mts` (background; ~150 codes x 5-45s = expect 30-90 minutes)
Expected: per-code progress lines; cumulative spend visible; guard stops before $15 if costs run hot.

- [ ] **Step 3: On completion, sanity-check the results file** — 150 rows (or guard-stop count), spend <= 15, no systemic `error` fields (isolated provider errors are fine; >20% errors on one provider = investigate before grading).

---

### Task 9: Grade, report, PDF second edition

**Files:**
- Create: `scripts/tmp-ladder-grade.mjs`
- Create (scratchpad): `make_probe_report_v2.py` -> Output: `reports/ai-model-probe-2026-07-04-v2.pdf`

**Interfaces:**
- Consumes: `scripts/tmp-ladder-dryrun-results.json` (Task 6 shape) + the four round JSONs (`tmp-pro-probe-results.json`, `tmp-pro-probe2-results.json`, `tmp-gemini-probe-results.json`, `tmp-claude-probe-results.json`).

- [ ] **Step 1: Write the grader**

```javascript
// scripts/tmp-ladder-grade.mjs
import { readFileSync } from "node:fs";
const { spent, results } = JSON.parse(readFileSync(new URL("./tmp-ladder-dryrun-results.json", import.meta.url), "utf8"));

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
const overlap = (a, b) => { const A = new Set(norm(a)); return norm(b).filter((w) => A.has(w)).length; };
// identity match: >=2 significant word overlap with truth OR truth contains the found brand+one word
const matches = (r) => r.product ? overlap(r.truth, r.product) >= 2 : false;

let wrongVerified = 0, verifiedOk = 0, findable = 0, cheapVerify = 0, cheapTried = 0, wrongLoudSuggest = 0;
const byGroup = {};
for (const r of results) {
  const g = (byGroup[r.group] ??= { n: 0, verified: 0, suggested: 0, refused: 0, wrong: 0, matched: 0 });
  g.n++; g[r.outcome] = (g[r.outcome] ?? 0) + 1;
  if (r.outcome === "verified") {
    if (r.expected === "must-refuse" || r.expected === "suggest-only" || !matches(r)) { wrongVerified++; g.wrong++; }
    else { verifiedOk++; }
    if (r.stage?.fetch?.verified) cheapVerify++;
  }
  if (r.expected === "verified-ok") findable++;
  if (r.stage?.fetch) cheapTried++;
  if (r.outcome === "suggested" && r.product && !matches(r) && (r.guessConfidence ?? 0) > 0.4) wrongLoudSuggest++;
  if (matches(r)) g.matched++;
}
const gates = {
  "wrong auto-counts (HARD FAIL if >0)": wrongVerified,
  "auto-count rate on findable (target >=70%)": `${((verifiedOk / Math.max(1, findable)) * 100).toFixed(1)}%`,
  "cheap-verify success (build if >=50%)": `${((cheapVerify / Math.max(1, cheapTried)) * 100).toFixed(1)}%`,
  "wrong suggestions above 0.4 (must be 0)": wrongLoudSuggest,
  "avg cost/code": `$${(spent / Math.max(1, results.length)).toFixed(3)}`,
  "total spend": `$${spent.toFixed(2)}`,
};
console.log("== GATES =="); for (const [k, v] of Object.entries(gates)) console.log(` ${k}: ${v}`);
console.log("== GROUPS =="); for (const [g, s] of Object.entries(byGroup)) console.log(` ${g}: ${JSON.stringify(s)}`);
console.log(`VERDICT: ${wrongVerified === 0 && cheapVerify / Math.max(1, cheapTried) >= 0.5 ? "BUILD Option B" : wrongVerified > 0 ? "HARD FAIL - redesign gate" : "cheap-verify weak - consider Option C or owner call"}`);
```

- [ ] **Step 2: Run the grader** (`node scripts/tmp-ladder-grade.mjs`) and manually spot-check 10 graded rows against the raw results (the word-overlap matcher is a heuristic - eyeball every `wrong*` finding before believing it; correct the grader if it mis-scores, re-run).

- [ ] **Step 3: PDF second edition** — extend the existing report generator (copy `make_probe_report.py` from the scratchpad session dir; if gone, rebuild from Task's data files following the same reportlab structure): add a "Round 3 Gemini / Round 4 Claude" scoreboard page and a "150-code dry run" page with the gates table, per-group scorecard, and verdict. Output `reports/ai-model-probe-2026-07-04-v2.pdf`; verify by text-extraction (pdfplumber) that all pages render.

- [ ] **Step 4: Summary + housekeeping commit**

```bash
git add scripts/tmp-ladder-grade.mjs scripts/tmp-ladder-dryrun-results.json reports/ai-model-probe-2026-07-04-v2.pdf
git commit -m "feat(dryrun): live 150-code ladder results, grader, PDF v2"
```

- [ ] **Step 5: Report to owner** — the 6 gates, per-group scorecard, build/no-build verdict, spend report (doctrine: wallet report always), and the explicit note that retail-DB-sourced codes would resolve free in production (they tested the ladder, not the full stack). Update PROGRESS.md with a checkpoint + memory file for session continuity.

---

## Self-Review

- Spec coverage: groups/sizes (Task 5) ✓, upgrades 1-3 (Tasks 1/2/6 wiring, ASIN Task 2) ✓, upgrade 4 (Task 3) ✓, $15 guard + mock-first (Task 6/8) ✓, gates + per-group scorecards (Task 9) ✓, PDF + spend report (Task 9) ✓, no-deploy/branch rules (Global Constraints) ✓.
- Placeholders: Task 6 carries two explicit pre-run fix-ups (detectCodeType import path, removing the placeholder param line) — deliberate, verified by the mock self-test which fails loudly if wrong. Task 9 Step 3 rebuilds the PDF generator from a described structure if the scratchpad copy is gone — acceptable: the structure exists in `reports/ai-model-probe-2026-07-03.pdf` and this session's history.
- Type consistency: fixture fields (Task 5) == probe row fields (Task 6) == grader fields (Task 9); `selectBarcodeUrls`/`verifyAsinPage`/`hostOnCooldown` names match across Tasks 1/2/3/6.
