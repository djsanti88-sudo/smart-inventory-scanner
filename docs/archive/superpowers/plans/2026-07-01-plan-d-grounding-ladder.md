# Plan D — Speed-first parallel identification ladder (barcode-DB ‖ flash-lite grounding), cached

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Branch: `fix/grounding-ladder` (stacked on C). Task 1 (Firecrawl provider) is already DONE (commit d145c7e).

**Goal:** Identify any code not in the corpus/cache as fast as possible: run the UPCitemdb barcode-DB and a `gemini-flash-lite` grounded lookup IN PARALLEL and take the first confident answer (~1 s); escalate to Firecrawl/premium only if BOTH miss; cache every win to 0 ms; a hit counts as Verified. Never fails to decode (prefix floor from Plan C).

**Architecture:** Decode entry is `computeDecode()` in `src/app/api/ai-lookup/route.ts` (corpus checks already run there before AI — Plan B). Plan D adds a parallel resolver AFTER the corpus/cache checks: two independent legs race, the winner is cached and returned as `verified`/`aiCalled` accordingly, and only a double-miss escalates. All external calls are wrapped so tests mock them (ZERO real spend/credits in tests). Live calls fire only in production on a cache-miss.

**Tech Stack:** TypeScript, Next.js server route, Vitest (mocked network), Playwright/curl for the live preview proof. Grounding model: `gemini-flash-lite-latest` (measured ~1.5 s, correct). Barcode DB: UPCitemdb trial (measured ~1 s, 4/4 correct in testing).

## Global Constraints (SPEED + COST rules — every task inherits these)

- **Speed is the priority.** For an unknown code, fire the barcode-DB leg and the grounding leg CONCURRENTLY (Promise.race-style on "first confident result"), do NOT run them sequentially. Target ~1 s wall-clock.
- **Grounding = `gemini-flash-lite-latest`** (NOT 2.5-flash/flash-latest — measured 6x slower and flakier) with a SHORT prompt: `What product has UPC barcode <code>? Reply only the brand and product name.` + `tools:[{google_search:{}}]`. When a specific URL is already known, use the `url_context` tool instead of `google_search` (token-only, cheaper — see [[plan-d-cost-optimizations]]).
- **Barcode DB:** UPCitemdb trial `GET https://api.upcitemdb.com/prod/trial/lookup?upc=<code>` -> `items[0].{title,brand}`. Try barcode variants (mirror `retailKnowledgeIndex.barcodeVariants`). On 429, that leg yields null (the grounding leg is the redundancy) — do not block.
- **A confident barcode-DB or grounding hit = Verified**, `aiCalled` reflects whether AI was used (grounding leg = true; barcode-DB-only = false). Return the winner immediately; cancel/ignore the loser.
- **Escalate only on DOUBLE MISS:** Firecrawl 1-credit basic scrape (Task 1's `firecrawlScrapeCheap`, 4-key rotation) -> then premium grounding -> then the Plan C prefix floor (never empty).
- **Cache every win** back to the catalog/store so the next scan of that code is a free 0 ms Tier-1 hit.
- **Firecrawl:** 1-credit basic scrape only, 4-key rotation, skip-empty (Task 1 done). Do NOT use the old 7-credit `discoverViaFirecrawl` path in the new flow.
- Cheapest models first inside any AI leg; premium (`gemini-2.5-pro`/`gpt-5`) only on escalation.
- Tests NEVER call live providers (mock fetch / SDK). Preview deploy only; production needs explicit owner sign-off. No em/en dashes. Commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Verification Gate (inherited): each task proven before advancing; loop-until-fixed via systematic-debugging; never advance while red.

## File Structure
- DONE `src/services/ai/firecrawlProvider.ts` — `firecrawlScrapeCheap()` (Task 1).
- New `src/server/retail-knowledge/barcodeDbProvider.ts` — UPCitemdb lookup, structured result + status.
- New `src/services/ai/flashLiteGrounding.ts` — fast `gemini-flash-lite` grounded identify (google_search) + `url_context` variant.
- New `src/services/ai/parallelResolve.ts` — the race orchestrator (barcode-DB ‖ grounding, first-confident-wins, escalate on double-miss).
- Modify `src/app/api/ai-lookup/route.ts` `computeDecode()` — call the parallel resolver after corpus/cache, before the legacy AI fast-path; cache wins via the existing catalog write.
- Tests alongside each new file.

---

### Task 1: Firecrawl cheap provider + 4-key rotation — DONE (commit d145c7e)
`firecrawlScrapeCheap()` 1-credit basic scrape, 4-key rotation, skip-on-402/429, null on exhaustion, SSRF-guarded, maxAge. 8 mocked tests green. No action needed except: Task 4 uses it and must NOT use the old `discoverViaFirecrawl` (7 credits).

### Task 2: Barcode-DB provider (UPCitemdb), structured + status

**Files:** Create `src/server/retail-knowledge/barcodeDbProvider.ts`; Test `src/server/retail-knowledge/barcodeDbProvider.test.ts`.

**Interfaces:**
- Produces: `lookupBarcodeDb(code: string, deps?: { fetch?: typeof fetch }): Promise<{ name: string; brand: string; sourceUrl: string } | null>` and `getLastBarcodeDbStatus(): "hit" | "miss" | "rate_limited" | "error" | "idle"`.

- [ ] **Step 1: Write the failing test** (mock fetch; NO live calls)

```typescript
import { describe, it, expect, vi } from "vitest";
import { lookupBarcodeDb, getLastBarcodeDbStatus } from "@/server/retail-knowledge/barcodeDbProvider";

const okResp = { items: [{ title: "Michelin LTX M/S2 All-Season P255/70R18 112T", brand: "Michelin", offers: [{ link: "https://x/y" }] }] };
function mockFetch(status: number, json: unknown) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => json })) as unknown as typeof fetch;
}
describe("barcode-DB provider (UPCitemdb)", () => {
  it("returns structured identity on a hit", async () => {
    const r = await lookupBarcodeDb("086699087829", { fetch: mockFetch(200, okResp) });
    expect(r?.brand).toBe("Michelin");
    expect(r?.name).toMatch(/LTX/);
    expect(getLastBarcodeDbStatus()).toBe("hit");
  });
  it("returns null + rate_limited on 429", async () => {
    const r = await lookupBarcodeDb("086699087829", { fetch: mockFetch(429, {}) });
    expect(r).toBeNull();
    expect(getLastBarcodeDbStatus()).toBe("rate_limited");
  });
  it("returns null + miss on empty items", async () => {
    const r = await lookupBarcodeDb("000000000000", { fetch: mockFetch(200, { items: [] }) });
    expect(r).toBeNull();
    expect(getLastBarcodeDbStatus()).toBe("miss");
  });
});
```

- [ ] **Step 2: Run -> FAIL** (`npx vitest run src/server/retail-knowledge/barcodeDbProvider.test.ts`).

- [ ] **Step 3: Implement** (verified against the real API shape in testing):

```typescript
// src/server/retail-knowledge/barcodeDbProvider.ts
type Status = "idle" | "hit" | "miss" | "rate_limited" | "error";
let _last: Status = "idle";
export function getLastBarcodeDbStatus(): Status { return _last; }

function variants(code: string): string[] {
  const s = code.replace(/^0+/, "") || "0";
  const v = new Set([code, s]);
  for (const b of [code, s]) { if (b.length <= 13) v.add(b.padStart(13, "0")); if (b.length <= 12) v.add(b.padStart(12, "0")); }
  return [...v];
}

export async function lookupBarcodeDb(code: string, deps?: { fetch?: typeof fetch }): Promise<{ name: string; brand: string; sourceUrl: string } | null> {
  const f = deps?.fetch ?? fetch;
  for (const v of variants(code.trim())) {
    let res: Response;
    try { res = await f(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(v)}`, { headers: { "User-Agent": "inventory-scanner" } }); }
    catch { _last = "error"; return null; }
    if (res.status === 429) { _last = "rate_limited"; return null; }
    if (!res.ok) { _last = "error"; continue; }
    const data = (await res.json()) as { items?: Array<{ title?: string; brand?: string; offers?: Array<{ link?: string }> }> };
    const item = data.items?.[0];
    if (item?.title) { _last = "hit"; return { name: item.title, brand: item.brand ?? "", sourceUrl: item.offers?.[0]?.link ?? "" }; }
  }
  _last = "miss";
  return null;
}
```

- [ ] **Step 4: Run -> PASS.** `npm run test` (0 failures), `npx tsc --noEmit`. Commit.

### Task 3: Fast flash-lite grounding provider

**Files:** Create `src/services/ai/flashLiteGrounding.ts`; Test `src/services/ai/flashLiteGrounding.test.ts`.

**Interfaces:**
- Produces: `groundIdentify(code: string, opts?: { url?: string; apiKey?: string; fetch?: typeof fetch }): Promise<{ text: string; grounded: boolean } | null>`. Uses `gemini-flash-lite-latest`; `url_context` tool when `opts.url` is set, else `google_search`. Returns null on empty/error (so the barcode-DB leg wins).

- [ ] **Step 1: Write the failing test** (mock fetch — NO live Gemini):

```typescript
import { describe, it, expect, vi } from "vitest";
import { groundIdentify } from "@/services/ai/flashLiteGrounding";

const geminiOk = { candidates: [{ content: { parts: [{ text: "Michelin LTX M/S2 tire" }] } }] };
const geminiEmpty = { candidates: [{ content: { role: "model" } }] };
function mockFetch(json: unknown) { return vi.fn(async (url: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => json, _url: url, _init: init })) as unknown as typeof fetch; }

describe("flash-lite grounding", () => {
  it("returns text + grounded on a usable answer, using flash-lite + google_search", async () => {
    const f = mockFetch(geminiOk);
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: f });
    expect(r?.text).toMatch(/Michelin/);
    const call = (f as any).mock.calls[0];
    expect(call[0]).toContain("gemini-flash-lite-latest");
    expect(JSON.parse(call[1].body).tools[0]).toHaveProperty("google_search");
  });
  it("uses url_context when a url is provided", async () => {
    const f = mockFetch(geminiOk);
    await groundIdentify("086699087829", { url: "https://x/y", apiKey: "k", fetch: f });
    expect(JSON.parse((f as any).mock.calls[0][1].body).tools[0]).toHaveProperty("url_context");
  });
  it("returns null on empty content", async () => {
    const r = await groundIdentify("086699087829", { apiKey: "k", fetch: mockFetch(geminiEmpty) });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run -> FAIL.**

- [ ] **Step 3: Implement** (verified against the real API in testing — short prompt, flash-lite):

```typescript
// src/services/ai/flashLiteGrounding.ts
const MODEL = process.env.GEMINI_GROUND_MODEL || "gemini-flash-lite-latest";
export async function groundIdentify(code: string, opts?: { url?: string; apiKey?: string; fetch?: typeof fetch }): Promise<{ text: string; grounded: boolean } | null> {
  const key = opts?.apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) return null;
  const f = opts?.fetch ?? fetch;
  const tool = opts?.url ? { url_context: {} } : { google_search: {} };
  const prompt = opts?.url
    ? `From ${opts.url}, what product has UPC barcode ${code}? Reply only the brand and product name.`
    : `What product has UPC barcode ${code}? Reply only the brand and product name.`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [tool] });
  let res: Response;
  try { res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join(" ").trim();
  if (!text) return null;
  return { text, grounded: !opts?.url };
}
```

- [ ] **Step 4: Run -> PASS.** `npm run test`, `npx tsc --noEmit`. Commit.

### Task 4: Parallel resolver + wire into computeDecode + cache

**Files:** Create `src/services/ai/parallelResolve.ts`; Test `parallelResolve.test.ts`; Modify `src/app/api/ai-lookup/route.ts` `computeDecode()` (read it first).

**Interfaces:**
- Consumes: `lookupBarcodeDb` (Task 2), `groundIdentify` (Task 3), `firecrawlScrapeCheap` (Task 1), the prefix floor (Plan C), the catalog cache-write path.
- Produces: `resolveUnknownFast(code, deps): Promise<{ name; brand; verified: boolean; aiCalled: boolean; source: "barcode_db"|"grounding"|"firecrawl"|"floor" } | null>`.

- [ ] **Step 1: Write the failing tests** — assert the RACE + escalation + first-confident-wins:
  (a) barcode-DB returns fast, grounding slow -> result is `source:"barcode_db"`, both were fired (parallel), loser ignored;
  (b) barcode-DB miss + grounding hit -> `source:"grounding"`, `aiCalled:true`;
  (c) both miss -> escalates to `firecrawlScrapeCheap` (mocked), then floor;
  (d) a cache hit path short-circuits (2nd resolve of same code does not call either leg).
  Mock all three providers. Run -> FAIL.

- [ ] **Step 2: Implement** the resolver: fire `lookupBarcodeDb(code)` and `groundIdentify(code)` concurrently; resolve as soon as EITHER returns a confident result (barcode-DB hit, or grounding text that passes an `isUsableProductName`-style check); prefer barcode-DB on a tie (structured). If BOTH resolve null, escalate: `firecrawlScrapeCheap(bestUrl)` + one premium grounding, then the Plan C prefix floor. On any win, cache it (catalog write) so the next scan is 0 ms. Wire the call into `computeDecode()` after the corpus/cache checks and before the legacy AI fast-path; a win returns `verified` with the right `aiCalled`.

- [ ] **Step 3:** Tests green. `npm run test` (0 failures), `npx tsc --noEmit`. Commit.

### Task 5: Gate + preview + live proof

- [ ] **Step 1:** `npm run test` (0 failures), `npx tsc --noEmit`, `npm run build`.
- [ ] **Step 2 (controller):** After push, ONE live curl of a non-corpus code through the deployed `/api/ai-lookup`; confirm it resolves `verified` in ~1 s via the parallel path. Capture output + latency.
- [ ] **Step 3:** Commit; controller pushes for the cumulative preview.

---

## Self-Review
- Speed-first parallel design (barcode-DB ‖ flash-lite grounding, first-good-wins) -> Task 4. Providers -> Tasks 1-3. Proof -> Task 5.
- Real, tested code for the barcode-DB (UPCitemdb, 4/4) and grounding (flash-lite, ~1.5s correct) providers — not fabricated.
- Already done (do NOT redo): counting (A), corpus lookup (B), Verified/Suggested + prefix floor (C), Firecrawl cheap provider (D-Task1).
- Cost/speed rules are the Global Constraints. Tests mock all external calls: building spends ZERO real credits.
- Out of scope (YAGNI): a 2nd barcode-DB source (grounding leg is the redundancy), residential proxies, the 4M food DB for tires (0/174 — useless here; leave wired, don't rely on it).
