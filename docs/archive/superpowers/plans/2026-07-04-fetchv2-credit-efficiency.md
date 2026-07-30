# Fetch V2.2 Credit Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-spending Firecrawl credits on codes proven dead (permanent no-result receipts, manual retry only) and give findable public barcodes a free pattern-URL shot before any paid search.

**Architecture:** Two additive pieces on the Fetch V2 engine (tag `fetchv2-2.1` = rollback point): (1) `FetchV2Cache` gains a permanent no-result receipt map; the pipeline short-circuits receipted codes and writes receipts only after COMPLETE empty probes; the benchmark persists receipts to a JSON file across runs with a `--force-retry` override. (2) A pre-discovery phase direct-fetches up to 2 predictable barcode-DB URLs (reusing V1's `selectBarcodeUrls`) so identity can be secured for $0; paid searches run only if that fails.

**Tech Stack:** TypeScript (Next.js repo conventions: pure services, no React imports), Vitest `unit` project, tsx benchmark scripts.

## Global Constraints

- ZERO AI calls anywhere; Brave free tier + Firecrawl only (owner order).
- Count-first contract inviolable: every outcome persists + increments (`makeResult` enforces it; do not touch).
- Canaries must never verify or suggest; receipts must never verify anything.
- Do not modify V1 (`src/services/ai/*`, `src/services/catalog/*`) — reuse by import only.
- Receipts are PERMANENT: no TTL, no auto-retry; only the benchmark flag `--force-retry` bypasses (owner rule 2026-07-04).
- A receipt may only be written when the probe COMPLETED (not `earlyStopped`, discovery providers all ran).
- Full suite green after every task; commit after every task; NO `git push` (owner gates pushes; v2.1 already pushed).
- Run all tests with: `npx vitest run src/services/fetchV2/` (fast) and `npm test` before the final commit.

---

### Task 1: No-result receipts in FetchV2Cache

**Files:**
- Modify: `src/services/fetchV2/cache.ts` (append inside the `FetchV2Cache` class, after `badUrlReason`)
- Test: `src/services/fetchV2/engine.test.ts` (append into the existing `describe("FetchV2Cache", ...)` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getNoResult(primary: string): string | undefined` and `markNoResult(primary: string, note: string): void` on `FetchV2Cache` — Task 2 and Task 4 call exactly these.

- [ ] **Step 1: Write the failing test** — append inside `describe("FetchV2Cache", ...)`:

```ts
  test("no-result receipts are permanent and round-trip by primary", () => {
    const cache = new FetchV2Cache();
    expect(cache.getNoResult("054137070573")).toBeUndefined();
    cache.markNoResult("054137070573", "probed 2026-07-04: brave+quoted+unquoted empty");
    expect(cache.getNoResult("054137070573")).toContain("probed 2026-07-04");
    expect(cache.getNoResult("other")).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/fetchV2/engine.test.ts -t "no-result receipts"`
Expected: FAIL with `cache.markNoResult is not a function`

- [ ] **Step 3: Write minimal implementation** — append inside the class in `cache.ts`:

```ts
  // --- No-result receipts (owner rule 2026-07-04): PERMANENT, no auto-retry ever. A receipted
  // code spends zero searches until the owner explicitly clears it (ladder handles the residue).
  private readonly noResults = new Map<string, string>();

  getNoResult(primary: string): string | undefined {
    return this.noResults.get(primary);
  }

  markNoResult(primary: string, note: string): void {
    if (this.noResults.size >= this.maxEntries) {
      const oldest = this.noResults.keys().next().value;
      if (oldest !== undefined) this.noResults.delete(oldest);
    }
    this.noResults.set(primary, note);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/fetchV2/engine.test.ts -t "no-result receipts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/fetchV2/cache.ts src/services/fetchV2/engine.test.ts
git commit -m "feat(fetchv2): permanent no-result receipts in FetchV2Cache"
```

---

### Task 2: Receipt short-circuit + receipt writing in the pipeline

**Files:**
- Modify: `src/services/fetchV2/index.ts` (two insertions, exact anchors below)
- Test: `src/services/fetchV2/engine.test.ts` (new `describe` block appended before the `// ---- discovery providers` section)

**Interfaces:**
- Consumes: `FetchV2Cache.getNoResult` / `markNoResult` (Task 1).
- Produces: pipeline behavior only — a receipted code returns `outcome: "unknown"` with a rule containing the word `receipt` and makes ZERO discovery calls; a COMPLETE empty probe calls `markNoResult(primary, note)`.

- [ ] **Step 1: Write the failing tests** — append as a new describe block:

```ts
describe("no-result receipts in the pipeline (credit efficiency)", () => {
  test("a receipted code spends ZERO searches and returns unknown (owner: no auto-retry)", async () => {
    const cache = new FetchV2Cache();
    cache.markNoResult("054137070573", "probed 2026-07-04");
    const search = vi.fn(async () => []);
    const r = await fetchV2("054137070573", { cache, fetchPage: vi.fn(), discovery: [{ name: "m", search }] });
    expect(search).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
    expect(r.debug.rulesFired.join(" ")).toMatch(/receipt/i);
    expect(r.countBehavior.mustIncrementQuantity).toBe(true);
  });

  test("a COMPLETE empty probe writes a receipt", async () => {
    const cache = new FetchV2Cache();
    await fetchV2("054137070573", { cache, fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [{ name: "m", search: async () => [] }] });
    expect(cache.getNoResult("054137070573")).toBeTruthy();
  });

  test("a budget-truncated probe does NOT write a receipt", async () => {
    const cache = new FetchV2Cache();
    let t = 0;
    await fetchV2("054137090250", { cache, now: () => (t += 30_000), fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [{ name: "m", search: async () => [] }] }, { maxTotalMs: 25_000 });
    expect(cache.getNoResult("054137090250")).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/fetchV2/engine.test.ts -t "receipts in the pipeline"`
Expected: 3 FAIL (first: search WAS called; second/third: `getNoResult` undefined behavior)

- [ ] **Step 3: Implement** — two insertions in `index.ts`:

(a) Immediately AFTER the verified-cache block (`// 2) Verified-result cache...` ends with `}`), insert:

```ts
  // 2b) No-result receipt: the code was fully probed before and every door was empty. Owner rule:
  // never auto-retry - the ladder handles the residue. Still counted (count-first contract).
  const receipt = deps.cache?.getNoResult(normalized.primary);
  if (receipt) {
    rulesFired.push(`no-result receipt on file (${receipt}) - owner: no auto-retry, ladder handles it`);
    return finish({ outcome: "unknown" });
  }
```

(b) At the very end of `fetchV2`, REPLACE the final two lines

```ts
  if (result.outcome === "verified") deps.cache?.saveVerified(normalized.primary, result);
  return result;
```

with:

```ts
  if (result.outcome === "verified") deps.cache?.saveVerified(normalized.primary, result);
  // Write a PERMANENT receipt only for a COMPLETE empty probe: discovery actually ran, the time
  // budget did not truncate it, and no identity or evidence of any kind was found.
  if (
    result.outcome === "unknown" &&
    !earlyStopped &&
    deps.discovery.length > 0 &&
    findings.length === 0
  ) {
    deps.cache?.markNoResult(normalized.primary, `probed ${new Date().toISOString().slice(0, 10)}: all doors empty`);
  }
  return result;
```

- [ ] **Step 4: Run the full fetchV2 suite**

Run: `npx vitest run src/services/fetchV2/`
Expected: ALL PASS (118 existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add src/services/fetchV2/index.ts src/services/fetchV2/engine.test.ts
git commit -m "feat(fetchv2): receipt short-circuit + complete-probe receipt writing"
```

---

### Task 3: Free pattern-URL door before paid discovery

**Files:**
- Modify: `src/services/fetchV2/index.ts` (add `patternUrls` to `FetchV2Deps`; add the pre-discovery phase)
- Test: `src/services/fetchV2/engine.test.ts`

**Interfaces:**
- Consumes: existing page-processing internals of `fetchV2`.
- Produces: optional dep `patternUrls?: (variants: string[]) => string[]` — Task 4 supplies it from V1's `selectBarcodeUrls`.

- [ ] **Step 1: Write the failing tests** — append to the credit-efficiency describe block:

```ts
  test("pattern URLs are fetched FREE first; identity secured skips every paid search", async () => {
    const C = "028400325042";
    const search = vi.fn(async () => []);
    const html = `<html><head><title>Doritos Cool Ranch - GoUPC</title>
<script type="application/ld+json">{"@type":"Product","name":"Doritos Cool Ranch Tortilla Chips 9.25 oz","brand":{"name":"Doritos"},"gtin13":"0028400325042"}</script></head><body>UPC ${C}</body></html>`;
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, html }));
    const r = await fetchV2(C, {
      fetchPage,
      discovery: [{ name: "m", search }],
      patternUrls: () => ["https://go-upc.example.com/search?q=" + C],
    });
    expect(["verified", "suggested"]).toContain(r.outcome);
    expect(r.product.name).toContain("Doritos");
    expect(search).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledWith("https://go-upc.example.com/search?q=" + C);
  });

  test("useless pattern pages fall through to normal discovery", async () => {
    const C = "028400325042";
    const search = vi.fn(async () => []);
    await fetchV2(C, {
      fetchPage: async () => ({ ok: false, status: 404, html: "" }),
      discovery: [{ name: "m", search }],
      patternUrls: () => ["https://go-upc.example.com/search?q=" + C],
    });
    expect(search).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/fetchV2/engine.test.ts -t "pattern"`
Expected: first FAILS (patternUrls unknown -> search called / no product); second passes trivially — that is acceptable, it guards the fall-through.

- [ ] **Step 3: Implement** — three edits in `index.ts`:

(a) Add to `FetchV2Deps`:

```ts
  /** Optional FREE door: predictable barcode-DB product URLs (V1 selectBarcodeUrls), fetched
   *  before any paid search. Max 2 are used. */
  patternUrls?: (variants: string[]) => string[];
```

(b) Hoist page-processing into a reusable closure. Inside the `if (needsDiscovery && deps.discovery.length > 0)` block, the current page loop body (from `let page: FetchedPage;` through the early-win `break`) moves into:

```ts
    const junkUrls = new Set<string>();
    const processPage = async (cand: DiscoveryCandidate): Promise<SourceFinding | null> => {
      let page: FetchedPage;
      try {
        page = await deps.fetchPage(cand.url);
      } catch {
        deps.cache?.markBadUrl(cand.url, "fetch failed");
        return null;
      }
      sourcesChecked.push(cand.url);
      if (!page.ok) {
        deps.cache?.markBadUrl(cand.url, `http ${page.status}`);
        return null;
      }
      const title = page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? cand.title;
      const text = htmlToText(page.html);
      const junk = evaluatePageJunk({ url: cand.url, title, text }, normalized.primary);
      if (junk.rejected) {
        if (junk.reasons.some((r) => /search|echo|no-result|not-found|invalidat|recycled|only in the url/i.test(r))) {
          junkUrls.add(cand.url);
        }
        deps.cache?.markBadUrl(cand.url, junk.reasons[0] ?? "junk page");
        const f: SourceFinding = { url: cand.url, association: { level: "none", matchedVariant: "", matchedField: "", product: null }, product: null, junkRejected: true, junkReasons: junk.reasons, quality: "rejected", score: 0 };
        findings.push(f);
        return f;
      }
      const products = extractProducts(page.html).map((p) => ({
        ...p,
        name: usableIdentityName(p.name, normalized.primary) ? p.name : "",
        brand: cleanBrand(p.brand),
      }));
      const association = proveAssociation(normalized.all, products, text, cand.url);
      if (association.level === "none" && products.length === 0) {
        deps.cache?.markBadUrl(cand.url, "no code evidence and no product structure");
      }
      const { quality, score } = scoreSource(cand.url, association, false);
      const f: SourceFinding = { url: cand.url, association, product: association.product, junkRejected: false, junkReasons: [], quality, score };
      findings.push(f);
      return f;
    };
```

The existing page loop becomes:

```ts
    for (const cand of prioritized) {
      if (timeLeft() <= 0) { earlyStopped = true; break; }
      const f = await processPage(cand);
      if (f && mode !== "strict" && f.association.level === "strong" && f.quality === "strong") {
        earlyStopped = true;
        break;
      }
    }
```

(c) BEFORE the provider loop (right after `let exactMatchCandidates: DiscoveryCandidate[] = [];`), insert the free door:

```ts
    // FREE pattern-URL door (owner: one good website is enough): predictable barcode-DB product
    // pages, direct-fetched before any paid search. Identity secured here = zero credits spent.
    if (deps.patternUrls && identifier.isPublicBarcode) {
      for (const url of deps.patternUrls(normalized.all).slice(0, 2)) {
        if (timeLeft() <= 0) { earlyStopped = true; break; }
        const f = await processPage({ url, title: "", snippet: "", rank: -1 });
        if (f && !f.junkRejected && f.association.level === "strong" && (f.product?.name ?? "").trim()) {
          rulesFired.push("free pattern-URL door secured the identity - paid search skipped");
          break;
        }
      }
    }
    const identitySecured = findings.some(
      (f) => !f.junkRejected && f.association.level === "strong" && (f.product?.name ?? "").trim(),
    );
```

and gate the provider loop with it:

```ts
    for (let i = 0; !identitySecured && i < deps.discovery.length; i++) {
```

NOTE: `processPage`, `junkUrls`, and the free door must all be declared ABOVE the provider loop; the `prioritized`/page-loop section stays below it unchanged apart from (b).

- [ ] **Step 4: Run the full fetchV2 suite + typecheck**

Run: `npx vitest run src/services/fetchV2/ && npx tsc --noEmit`
Expected: ALL PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/services/fetchV2/index.ts src/services/fetchV2/engine.test.ts
git commit -m "feat(fetchv2): free pattern-URL door before paid discovery"
```

---

### Task 4: Benchmark wiring — persistent receipts, --force-retry, pattern URLs

**Files:**
- Modify: `scripts/fetchv2-benchmark.mts`
- Create (at runtime): `scripts/fetchv2-noresult-receipts.json`

**Interfaces:**
- Consumes: Task 1-3 APIs (`markNoResult`, `getNoResult`, `patternUrls`).
- Produces: benchmark behavior; no code consumes it.

- [ ] **Step 1: Add receipt persistence + flag + pattern door.** Near the other flag parsing add:

```ts
const FORCE_RETRY = process.argv.includes("--force-retry"); // owner's manual override for receipts
const RECEIPTS = new URL("./fetchv2-noresult-receipts.json", import.meta.url);
```

In `main()` right after `const cache = new FetchV2Cache();` add:

```ts
  let receipts: Record<string, string> = {};
  try { receipts = JSON.parse(readFileSync(RECEIPTS, "utf8")); } catch { /* first run */ }
  if (!FORCE_RETRY) for (const [code, note] of Object.entries(receipts)) cache.markNoResult(code, note);
```

Add to `deps` (import `selectBarcodeUrls` from `../src/services/ai/barcodeSources`):

```ts
    patternUrls: (variants) => {
      const code = variants.find((v) => /^\d{12,14}$/.test(v)) ?? variants[0];
      return selectBarcodeUrls(code).slice(0, 2);
    },
```

After each row is processed (immediately after `rows.push(row); save();`) add:

```ts
    const note = cache.getNoResult(fx.code);
    if (note && !receipts[fx.code]) {
      receipts[fx.code] = note;
      writeFileSync(RECEIPTS, JSON.stringify(receipts, null, 1));
    }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add scripts/fetchv2-benchmark.mts
git commit -m "feat(fetchv2): benchmark receipt persistence, --force-retry, pattern-URL door"
```

---

### Task 5: Live proof — the double-pass zero-spend test

**Files:** none created; uses `scripts/fetchv2-benchmark.mts` and a 5-code slice.

- [ ] **Step 1: Pick the slice** — 3 known-dead codes + 2 findable ones:

```bash
CODES="4981910884903,086699058874,092971144814,092971262761,690677301168"
```

- [ ] **Step 2: Pass 1 (writes receipts for the dead trio)**

Run: `FC_CREDIT_CAP=60 npx tsx scripts/fetchv2-benchmark.mts --live --fixture=fetchv2-db-sample-200.json --out=fetchv2-v22-pass1.json --codes=$CODES`
Expected: findable pair decode (suggested/verified); console shows credits > 0; `scripts/fetchv2-noresult-receipts.json` now contains the 3 dead codes.

- [ ] **Step 3: Pass 2 (the proof)**

Run: `FC_CREDIT_CAP=60 npx tsx scripts/fetchv2-benchmark.mts --live --fixture=fetchv2-db-sample-200.json --out=fetchv2-v22-pass2.json --codes=4981910884903,086699058874,092971144814`
Expected: **firecrawl credits = 0**, all 3 rows `unknown` with a `receipt` rule, each row completes in under a second.

- [ ] **Step 4: Full suite + certify**

Run: `npm test && npx tsc --noEmit`
Expected: everything passes.

- [ ] **Step 5: Final commit + tag**

```bash
git add scripts/fetchv2-noresult-receipts.json scripts/fetchv2-v22-pass1.json scripts/fetchv2-v22-pass2.json
git commit -m "feat(fetchv2): v2.2 credit efficiency - receipts + free pattern door, live zero-spend proof"
git tag fetchv2-2.2
```

(NO push — owner gates pushes.)
