# Decode Ladder (Go-UPC + full chain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner-approved decode ladder (spec v6+: `docs/superpowers/specs/2026-07-08-go-upc-decode-rung-design.md`) — local corpora -> Go-UPC -> Fetch V2 -> GPT-5.5 — with count-first durability, identity-merge, raw archive, hard caps, and staged live proof graded by lower-tier models.

**Architecture:** Deterministic-first waterfall. Every scan persists BEFORE decode (HARD RULE 0). Free local corpora (76K tires + 4M retail) answer first; Go-UPC (paid quota, deterministic, exact hits auto-count) answers GTIN misses; Fetch V2.3+ (web evidence engine) and finally GPT-5.5 (optimized prompt, spend-gated) handle only the hard tail. Everything paid is archived raw with provenance.

**Tech Stack:** Next.js 16 App Router (server routes), TypeScript, better-sqlite3 (knowledge DB), Vitest (node project for services, jsdom for stores/components), Playwright E2E (`IS_E2E=1`, `page.route` mocks), existing engines: `fetchV2` (v2.3+), `gptFromScratch`.

## Global Constraints (from spec — every task inherits these)

- HARD RULE 0 count-first: scan event persisted + feed row visible BEFORE any lookup; decode only upgrades identity asynchronously; total rung failure still leaves the raw row + Needs Review entry.
- Ladder order: resolver/aliases -> decode cache/corpora -> [GTIN gate] -> Go-UPC -> Fetch V2 -> GPT-5.5 -> Needs Review. Gemini is REMOVED from decode.
- Go-UPC: Bearer header only; server-side only (`GO_UPC_API_KEY`); 2 req/s throttle + in-flight dedup; monthly HARD STOP `GO_UPC_MONTHLY_LIMIT` (default 4800), soft warn 4000; misses negative-cached 30 days keyed by canonical GTIN; exact hit (`inferred:false`) auto-counts with NO checks; `inferred:true` -> suggestion only.
- GPT-5.5 full model (`gpt-5.5`), probe-parity call shape, evidence gate unchanged (verified = exactCodeFound && confidence >= 0.8); AI Model Rules: raw code only, NO hints, NO app-side questioning of answers, no layered rules.
- Identity-merge: exact canonical-GTIN match auto-links alias to existing product; fuzzy brand+name NEVER auto-merges (plus-generation trap: R8 vs R8+), always a one-tap suggestion.
- Raw archive: every paid 200 archived complete (raw JSON + source URLs + retrieval metadata); archive survives corpus purges; images stored as URLs only.
- Tenant trust: human links fully trusted but write ONLY tenant-scoped data; global catalog writable only by platform owner + verified pipeline.
- Test safety: automated tests NEVER call live providers (mock `fetch`; E2E `page.route` + `IS_E2E=1`). Live proof is owner-gated, uses HARD codes for tail rungs, caps stated up front.
- Keys: server-side only, names in `.env.example`, `keySafety.test.ts` enforced. No em/en dashes in user-facing copy. Services stay pure (no React/next imports in `src/services`).
- Cost truth: worst case reserved for unmeterable spend; wallet reports say "computed floor $X; true spend = provider console".

## File Map

| File | Responsibility |
|---|---|
| `src/services/upc/gtin.ts` (+`.test.ts`) | Canonical GTIN form, variants, check-digit validation |
| `src/services/upc/goUpcClient.ts` (+`.test.ts`) | Pure Go-UPC REST wrapper, typed outcomes |
| `src/services/upc/goUpcThrottle.ts` (+`.test.ts`) | 2 req/s queue + in-flight dedup (server-side singleton) |
| `src/server/upc/goUpcUsage.ts` (+`.test.ts`) | File-backed monthly counter, warn/hard-stop gate |
| `src/server/upc/GoUpcProvider.ts` (+`.test.ts`) | Rung: client+throttle+usage+cache+archive -> decode outcome |
| `src/server/decodeArchive.ts` (+`.test.ts`) | Append-only raw response archive (JSONL per month) |
| `src/services/catalog/identityMerge.ts` (+`.test.ts`) | Existing-product match: gtin auto-link / fuzzy suggest |
| `src/services/ai/barcodeSources.ts` (modify) | + meros.io door |
| `src/services/fetchV2/sources/brocade.ts` (+test) | Free brocade.io structured source |
| `src/services/ai/gptFromScratch.ts` (modify +test) | Prompt v3 (optimized), category field |
| `src/app/api/ai-lookup/route.ts` (modify) | Ladder wiring: Go-UPC rung + Fetch V2 rung before GPT; Gemini removed |
| `src/stores/scanStore.ts` (modify +test) | Identity-merge on decode apply; count-first regression |
| `src/server/corpusPurge.ts` + `scripts/corpus-purge.mjs` (+test) | Purge/revalidate by provenance |
| `scripts/eval-prefix-db.mjs` | OFFLINE meros prefix-DB evaluation (report only) |
| `e2e/goupc-ladder.spec.ts` | E2E proof (mocked), screenshots |
| `scripts/proof-rung-*.mjs` / `scripts/proof-full-ladder.mjs` | Staged live proofs (owner-gated) |

---

## Phase A — Foundations

### Task 1: GTIN utilities

**Files:**
- Create: `src/services/upc/gtin.ts`
- Test: `src/services/upc/gtin.test.ts`

**Interfaces:**
- Produces: `canonicalGtin(code: string): string | null` (canonical digits, no padding decisions leak elsewhere), `gtinVariants(code: string): string[]`, `isValidCheckDigit(code: string): boolean`, `isGtinShaped(code: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/upc/gtin.test.ts
import { describe, it, expect } from "vitest";
import { canonicalGtin, gtinVariants, isValidCheckDigit, isGtinShaped } from "./gtin";

describe("gtin utilities", () => {
  it("canonicalizes UPC-A and its zero-padded EAN-13 to the SAME key", () => {
    expect(canonicalGtin("036000291452")).toBe(canonicalGtin("0036000291452"));
  });
  it("returns null for non-GTIN input", () => {
    expect(canonicalGtin("DCB205")).toBeNull();
    expect(canonicalGtin("X004DY7YUT")).toBeNull();
  });
  it("variants cover 12/13/14 digit zero-pads (matches retailKnowledgeIndex behavior)", () => {
    const v = gtinVariants("848983006257");
    expect(v).toContain("848983006257");
    expect(v).toContain("0848983006257");
    expect(v).toContain("00848983006257");
  });
  it("validates GS1 check digits", () => {
    expect(isValidCheckDigit("036000291452")).toBe(true);  // real UPC-A
    expect(isValidCheckDigit("036000291453")).toBe(false); // last digit off by one
    expect(isValidCheckDigit("4006381333931")).toBe(true); // real EAN-13
  });
  it("isGtinShaped accepts 8/12/13/14 digits only", () => {
    expect(isGtinShaped("12345678")).toBe(true);
    expect(isGtinShaped("1234567")).toBe(false);
    expect(isGtinShaped("FL-820-S")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/upc/gtin.test.ts`
Expected: FAIL ("Cannot find module './gtin'")

- [ ] **Step 3: Implement**

```ts
// src/services/upc/gtin.ts
// GTIN utilities for the decode ladder. Pure, no imports. One product = one canonical key,
// so cache/corpus/billing never pay twice for the same product in two encodings.

export function isGtinShaped(code: string): boolean {
  const t = (code ?? "").trim();
  return /^\d{8}$|^\d{12,14}$/.test(t);
}

/** GS1 mod-10 check digit over the full code (last digit is the check). */
export function isValidCheckDigit(code: string): boolean {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return false;
  const digits = t.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // weights 3,1,3,... from the RIGHTMOST payload digit
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** Canonical form: strip leading zeros down to the shortest valid GTIN length (>= 8 digits kept as-is). */
export function canonicalGtin(code: string): string | null {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return null;
  const stripped = t.replace(/^0+/, "");
  return stripped.padStart(Math.max(stripped.length, 12), "0").slice(-14).replace(/^0+(?=\d{12})/, "") || null;
}

/** Zero-pad variants (12/13/14) — same scheme retailKnowledgeIndex.barcodeVariants uses. */
export function gtinVariants(code: string): string[] {
  const t = (code ?? "").trim();
  const stripped = t.replace(/^0+/, "") || "0";
  const out = new Set([t, stripped]);
  for (const base of [t, stripped]) {
    if (base.length <= 14) out.add(base.padStart(14, "0"));
    if (base.length <= 13) out.add(base.padStart(13, "0"));
    if (base.length <= 12) out.add(base.padStart(12, "0"));
  }
  return [...out].filter((c) => c.length >= 8 && c.length <= 14);
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run src/services/upc/gtin.test.ts` -> PASS. If the canonical test fails on edge lengths, simplify `canonicalGtin` to `stripped` (leading-zeros removed) and update the test to assert equality of the two encodings only — equality is the contract, not the exact string.
- [ ] **Step 5: Commit** — `git add src/services/upc && git commit -m "feat(upc): gtin canonical form, variants, check digit"`

### Task 2: Raw decode archive (server)

**Files:**
- Create: `src/server/decodeArchive.ts`
- Test: `src/server/decodeArchive.test.ts`

**Interfaces:**
- Produces: `appendDecodeArchive(entry: DecodeArchiveEntry): void` and `readDecodeArchive(month: string): DecodeArchiveEntry[]`; `DecodeArchiveEntry = { code, canonicalGtin, provider: "go-upc"|"fetchv2"|"gpt-5.5", httpStatus?, raw: unknown, sourceUrls?: string[], fetchedAt: string }`.
- Storage: `data/decode-archive/<YYYY-MM>.jsonl` (append-only; separate from corpus rows so purges never destroy evidence). Directory override via `DECODE_ARCHIVE_DIR` for tests.

- [ ] **Step 1: Failing test** — append two entries into a temp dir (`DECODE_ARCHIVE_DIR`), read them back, assert order + fields survive round-trip, and that appending never rewrites existing lines (open with `a` flag).
- [ ] **Step 2: Run: `npx vitest run src/server/decodeArchive.test.ts`** -> FAIL
- [ ] **Step 3: Implement** — `import "server-only";` guard like `knowledgeDb.ts`; `mkdirSync(recursive)` on first append; `appendFileSync(path, JSON.stringify(entry) + "\n")`; reader splits lines, JSON.parse, skips corrupt lines with a console.warn (never throws on read).
- [ ] **Step 4: Test passes**
- [ ] **Step 5: Commit** — `feat(server): raw decode archive (append-only JSONL, purge-proof)`

---

## Phase B — Go-UPC rung internals

### Task 3: Go-UPC client

**Files:**
- Create: `src/services/upc/goUpcClient.ts`
- Test: `src/services/upc/goUpcClient.test.ts`

**Interfaces:**
- Produces:
```ts
export type GoUpcOutcome =
  | { kind: "hit"; inferred: boolean; product: GoUpcProduct; raw: unknown }
  | { kind: "miss" }                       // 404: genuine not-in-DB
  | { kind: "bad_format" }                 // 400
  | { kind: "auth_failed" }                // 401
  | { kind: "quota" }                      // 429
  | { kind: "transient"; detail: string }; // timeout / 5xx / malformed JSON
export interface GoUpcProduct { name: string; brand: string; description: string; imageUrl: string; category: string; specs: [string, string][]; upc?: string; ean?: string }
export async function goUpcLookup(code: string, deps: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<GoUpcOutcome>
```

- [ ] **Step 1: Failing tests** (mocked `fetchImpl`, one per outcome):
  - 200 `{product:{name,brand,...}, inferred:false}` -> `kind:"hit"`, `inferred:false`, fields mapped, `raw` preserved verbatim.
  - 200 with `inferred:true` -> `inferred:true`.
  - 404 -> `miss`; 400 -> `bad_format`; 401 -> `auth_failed`; 429 -> `quota`; fetch throws AbortError -> `transient`; 200 non-JSON -> `transient`.
  - Auth: assert the mock saw `Authorization: Bearer testkey` header and the URL contains NO `key=` query param.
  - Timeout default 10_000ms via `AbortSignal.timeout`.
- [ ] **Step 2:** `npx vitest run src/services/upc/goUpcClient.test.ts` -> FAIL
- [ ] **Step 3: Implement** — `GET https://go-upc.com/api/v1/code/${encodeURIComponent(code)}`; map statuses exactly as above; specs default `[]`; strings defaulted `""` via a `str()` helper (copy the one in `gptFromScratch.ts:44`). Pure module: no env reads, no imports from server/.
- [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(upc): Go-UPC client with typed outcomes, Bearer-only auth`

### Task 4: Throttle + in-flight dedup

**Files:** Create `src/services/upc/goUpcThrottle.ts`, test `src/services/upc/goUpcThrottle.test.ts`

**Interfaces:**
- Produces: `class GoUpcGate { constructor(opts?: { minGapMs?: number; now?: () => number }) ; run<T>(key: string, fn: () => Promise<T>): Promise<T> }` — serializes calls >= 500ms apart (2/s), and two concurrent `run("X", ...)` with the same key share ONE `fn()` invocation.

- [ ] **Step 1: Failing tests** — (a) `vi.useFakeTimers()`: three `run()` calls start at t=0; assert fn2 starts >= 500ms after fn1, fn3 >= 500ms after fn2. (b) dedup: two concurrent `run("same", spy)` -> spy called once, both promises resolve to its value; after settle, a third call invokes spy again. (c) a rejected fn rejects both waiters and clears the in-flight slot.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** — a promise-chain tail for spacing (`tail = tail.then(waitRemaining)`), and a `Map<string, Promise<unknown>>` for in-flight keyed dedup with `finally(() => map.delete(key))`.
- [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(upc): 2 req/s gate with in-flight dedup`

### Task 5: Monthly usage counter + hard stop

**Files:** Create `src/server/upc/goUpcUsage.ts`, test `src/server/upc/goUpcUsage.test.ts`

**Interfaces:**
- Produces: `goUpcUsage(dir?: string)` returning `{ canSpend(): { allowed: boolean; reason?: string; used: number; limit: number; warn: boolean }, record(): void }`. File `.go-upc-usage.json` `{ month: "2026-07", used: n }` (same pattern as `.ai-lookup-usage.json`). Limit = `Number(process.env.GO_UPC_MONTHLY_LIMIT ?? 4800)`, warn at 4000. Month rollover resets `used`.

- [ ] **Step 1: Failing tests** — temp dir: fresh file -> allowed, used 0; `record()` x3 -> used 3; used=4800 -> `allowed:false`, reason contains "monthly cap"; used=4001 -> `warn:true`; stored month != current month -> resets to 0; `GO_UPC_MONTHLY_LIMIT=10` respected. Inject clock via optional `now` param — do NOT call `new Date()` in tests.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** (`import "server-only"`, sync fs like `.ai-lookup-usage.json` handling)  - [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(upc): monthly usage counter, warn 4000, hard stop 4800`

### Task 6: Key safety extension

**Files:** Modify `src/services/keySafety.test.ts`

- [ ] **Step 1:** Add `GO_UPC_API_KEY` to the guarded key-name list in the existing scan (same assertion style as `GEMINI_API_KEY`). Add `GO_UPC_API_KEY=` (name only) to `.env.example`, and `GO_UPC_MONTHLY_LIMIT=4800`.
- [ ] **Step 2:** `npx vitest run src/services/keySafety.test.ts` -> PASS (fails only if someone client-reads it — that is the point).
- [ ] **Step 3: Commit** — `test(security): GO_UPC_API_KEY never client-readable`

### Task 7: GoUpcProvider (the rung)

**Files:** Create `src/server/upc/GoUpcProvider.ts`, test `src/server/upc/GoUpcProvider.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 + `appendDecodeArchive` (Task 2) + decode cache store for the 30-day negative cache (`src/server/decodeCacheStore.ts` — follow `TireKnowledgeProvider.ts` for the result/decision shapes).
- Produces: `goUpcRung(code: string, deps): Promise<GoUpcRungResult>` where `GoUpcRungResult = { path: "goupc_exact"|"goupc_inferred"|"goupc_miss"|"goupc_unavailable"; decision?: DecodeDecision; results?: AiLookupResult[]; reason: string }`. Shapes: exact hit -> decision `status:"verified"` with `exactCodeEvidenceVerifiedByApp:true`, `verifiedFacts:["Go-UPC exact barcode match"]`, provider name `"go-upc"` (mirror `TireKnowledgeProvider.toResult`); inferred -> `status:"needs_review"` with the product attached as suggestion; miss -> negative-cache write (TTL 30d, canonical GTIN key); quota/auth/missing-key -> `goupc_unavailable` with the exact reason string from the spec's error table.

- [ ] **Step 1: Failing tests** (all deps injected/mocked): exact hit maps to verified decision + archive appended + usage recorded; inferred -> needs_review suggestion + archived + NO negative cache; miss -> negative cache written with 30d TTL + falls through; second call on cached miss does NOT invoke client (spy) within TTL; expired TTL calls again; `canSpend().allowed=false` -> `goupc_unavailable`, client NEVER called, reason "Go-UPC monthly cap reached"; 429 -> reason "Go-UPC quota exhausted"; transient -> fall-through, NOT negative-cached; missing key -> skipped with reason; non-GTIN input (`isGtinShaped` false or bad check digit) -> `goupc_miss` with reason "not a GTIN / failed check digit", client never called.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** (thin composition; every branch returns an explicit `reason` — never silent)  - [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(upc): Go-UPC rung (exact auto-verify, inferred suggest, 30d miss cache, loud fallbacks)`

---

## Phase C — Ladder wiring (route + store)

### Task 8: Route wiring — Go-UPC + Fetch V2 rungs, Gemini removed

**Files:** Modify `src/app/api/ai-lookup/route.ts`; test `src/app/api/ai-lookup/ladderOrder.test.ts` (create; mock all rungs)

**Interfaces:**
- Consumes: `goUpcRung` (Task 7); existing corpus lookups (tire + retail) already in the route; existing `fetchV2` service; existing `gptFromScratch` ladder step.
- Produces: rung order inside the POST handler AFTER the existing corpus/cache steps and BEFORE any paid AI: `goUpcRung` -> (miss) `fetchV2` -> (nothing usable) `gptFromScratch`. Response `debug.path` reports which rung answered. Gemini providers are not constructed for decode at all (delete the construction, keep imports used elsewhere).

- [ ] **Step 1: Failing test** — unit-test a new pure helper `runLadder(code, rungs)` extracted from the route: given stubs, assert (a) order of invocation goupc->fetchv2->gpt, (b) goupc exact STOPS the ladder (fetchv2+gpt spies uncalled), (c) goupc inferred stops paid rungs too (suggestion outcome), (d) goupc unavailable falls to fetchv2 with reason threaded into `providerStatuses`, (e) fetchv2 verified/suggested stops GPT, (f) all-miss -> needs_review reason lists every rung's reason, (g) vendor-shaped code skips goupc (gate).
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** — extract `runLadder` into `src/server/upc/ladder.ts` so the route stays thin; wire into route; delete Gemini from the decode provider list; run the FULL unit suite (`npm run test`) to catch every test asserting Gemini presence and update those tests' expectations (they now assert Gemini absent — cite spec v5).
- [ ] **Step 4: PASS (full suite)**  - [ ] **Step 5: Commit** — `feat(ladder): corpus -> Go-UPC -> FetchV2 -> GPT; Gemini out of decode (spec v6)`

### Task 9: Count-first regression + identity-merge in the store

**Files:** Modify `src/stores/scanStore.ts`; Create `src/services/catalog/identityMerge.ts` + test; store test additions in `src/stores/scanStore.countfirst.test.ts`

**Interfaces:**
- Produces: `findIdentityMerge(existing: Product[], decoded: { gtin?: string|null; brand?: string; name?: string }): { kind: "auto_link"; productId: string } | { kind: "suggest_link"; productId: string } | { kind: "none" }` — auto_link ONLY on canonical-GTIN equality; suggest_link on normalized-brand equality + name similarity >= 0.75 (token Jaccard) BUT ONLY when neither name contains a "+"/generation marker difference (e.g. `r8` vs `r8+`, `hdr` vs `hdr+` -> suggest, never auto — encode this exact case as a test).
- Store: applying a decode result runs identity-merge first; auto_link attaches the scanned code as a new alias on the existing product and increments it (never a duplicate row); suggest_link raises a Needs Review "link to existing product?" item.

- [ ] **Step 1: Failing tests** — identityMerge unit: gtin equal (across encodings, via `canonicalGtin`) -> auto_link; same brand + "dimax r8" vs "dimax r8+" -> suggest_link never auto; different brands -> none. Store test: scan UPC -> decode-applied product created qty 1; scan SKU whose decode carries the same GTIN -> SAME row qty 2 + 2 aliases (assert product count unchanged). Count-first test: stub every ladder API to reject -> raw feed row + Needs Review entry still exist and survive a persist/rehydrate cycle.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement**  - [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(catalog): identity-merge (gtin auto-link, fuzzy suggests, plus-generation guard) + count-first regression`

### Task 10: Structurer harvest of Go-UPC fields

**Files:** Modify `src/services/polish/structurer.ts` (+ its test)

- [ ] **Step 1: Failing test** — feed a Go-UPC raw product (Falken fixture from today's run: name `"Falken Wildpeak A/T3W 265/70R17 115T Tire"`, specs pairs, imageUrl, category) -> normalized product has brand `Falken`, tire size `265/70R17`, load/speed `115T`, imageUrl passed through, category mapped, `source: "go-upc"` provenance.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** (reuse existing tire-size regex from `tireSpecs.ts` — do not write a new one)  - [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(polish): structurer maps Go-UPC fields (specs, image, category, provenance)`

---

## Phase D — Free doors, prefix DB, GPT prompt v3

### Task 11: Free doors — meros.io page door + brocade.io structured source

**Files:** Modify `src/services/ai/barcodeSources.ts` (+test); Create `src/services/fetchV2/sources/brocade.ts` (+test)

- [ ] **Step 1: Failing tests** — barcodeSources: `selectBarcodeUrls("848983006257")` includes `https://meros.io/848983006257` in the us tier. brocade: mocked fetch of `https://www.brocade.io/api/items/0074887615305` returning `{gtin, name, brand_name}` maps to a `StructuredHit` (same shape as the Open Food Facts source in `fetchv2-benchmark.mts:180-203`); 404 -> null; malformed -> null.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** — add `{ host: "meros.io", tiers: ["us", "generic"], url: (raw) => \`https://meros.io/${encodeURIComponent(raw)}\` }` to `BARCODE_SOURCES`; brocade module exports `brocadeLookup(variants: string[]): Promise<StructuredHit | null>` for the Fetch V2 `structured` deps array.
- [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(fetchv2): meros.io door + brocade.io free structured source`

### Task 12: GPT prompt v3 (optimized — owner order)

**Files:** Modify `src/services/ai/gptFromScratch.ts`; test `src/services/ai/gptFromScratch.test.ts`

**The v3 prompt** (replaces `promptFor`, resolves the spec's 3-option decision as option 2+3 combined; no hints about expected category are ever added — the code is still the only input):

```ts
const promptFor = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. Return JSON only: ` +
  `{"brand":"","productName":"","category":"","specs":"","gtin":"","confidence":0.0,` +
  `"exactCodeFound":false,"basis":"","sourceUrls":[]}. ` +
  `If you find this exact code on a real page, set exactCodeFound true, copy the product ` +
  `identity EXACTLY as the page states it (brand, full product name, size/variant), and set ` +
  `confidence to match the evidence. If you cannot find the exact code, you may give ONE best ` +
  `guess ONLY when concrete evidence points to a specific product (prefix ownership, near-identical ` +
  `listings, partial code matches) - set exactCodeFound false, confidence 0.4 or less, name the ` +
  `category, and cite the evidence in basis. If you have no evidence-based guess, return an empty ` +
  `productName and say in basis what you searched and why nothing qualified. Never invent a product. ` +
  `Always fill category with the product type you believe the barcode belongs to, even when ` +
  `productName is empty. Keep it brief.`;
```

Rationale recorded for the reviewer: keeps probe-parity recall on findable codes (the always-answer property applies where evidence exists), kills the junk-guess clause that produced a music CD for a Toyo tire, and the mandatory `category` field lets the UI label weak guesses ("guess - music CD?") with zero app-side questioning of the answer.

- [ ] **Step 1: Failing tests** (mocked fetch): parser reads the new `category` field into the result (`GptFromScratchResult` gains `category: string`); empty `productName` + any category -> tier `none` is NOT forced — it stays `suggested` ONLY if productName non-empty, else `none` (update `gptTierFor` call sites: tier none when productName empty); prompt string contains "Never invent a product" and does NOT contain "Never leave productName empty".
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement** (prompt + `category` plumb-through; `gptLadderRung.ts` passes category into the suggestion it emits)  - [ ] **Step 4: PASS + full suite** (`npm run test`)  - [ ] **Step 5: Commit** — `feat(ai): GPT prompt v3 - evidence-gated guesses, honest empty, category field`

### Task 13: Prefix-DB evaluation (OFFLINE report; adoption owner-gated)

**Files:** Create `scripts/eval-prefix-db.mjs` (temp tooling, no src changes)

Context for the engineer: the catalog-derived prefix map lives in `src/services/catalog/brandPrefixGeneral.ts` / `derivedPrefixMap.json`; the one confirmed Go-UPC error today (barcode prefix 092971 = Bridgestone family, Go-UPC answered Westlake) is exactly the class a prefix firewall catches. meros.io publishes free prefix pages (`https://meros.io/<7-digit-prefix>`). Owner decision "auto-count NO checks" stands — this task only MEASURES what a prefix check would have caught, it changes no behavior.

- [ ] **Step 1:** Script: load `scripts/tmp-goupc-200-tires-results.json`; for each hit, look up the barcode's prefix in the EXISTING derived prefix map; report: how many hits carry a known prefix, how many prefix-brand vs Go-UPC-brand disagreements exist, and whether 092971135485 (Westlake/Blizzak) is flagged. Optionally fetch up to 20 meros.io prefix pages (free, 1 req/s pacing) for prefixes MISSING from the map and report the coverage delta. Output: `scripts/prefix-db-eval-report.md` with a GO/NO-GO recommendation table.
- [ ] **Step 2:** Run it; commit the report. NO behavior change without a new owner decision recorded in the spec.
- [ ] **Step 3: Commit** — `chore(eval): prefix-DB value report for Go-UPC hits (no behavior change)`

---

## Phase E — Ops tooling + data fixes

### Task 14: Provenance purge/revalidate

**Files:** Create `src/server/corpusPurge.ts` (+test), `scripts/corpus-purge.mjs` (thin CLI)

**Interfaces:** `purgeBySource(opts: { source: "go-upc"|"gpt"|"fetchv2"; mode: "dry-run"|"purge"|"revalidate"; store: MockDbLike }): { matched: number; removed: number; requeued: number }` — dry-run lists only; purge removes corpus rows + aliases learned from that source (NEVER archive entries); revalidate flags rows for re-decode on next scan.

- [ ] **Step 1: Failing tests** — seed a mock store with rows of mixed provenance; dry-run: `removed:0` + correct `matched`; purge removes only the target source, human rows untouched; archive file untouched (spy); revalidate sets `needsRevalidation:true` without deleting.
- [ ] **Step 2:** FAIL  - [ ] **Step 3: Implement + CLI** (`node scripts/corpus-purge.mjs --source go-upc --dry-run`)  - [ ] **Step 4: PASS**  - [ ] **Step 5: Commit** — `feat(ops): corpus purge/revalidate by provenance (one-command quarantine)`

### Task 15: Data fixes surfaced by testing

**Files:** Modify `e2e/fixtures/dryrun-codes.json`; corpus fix notes

- [ ] **Step 1:** Fix the 4 shifted Frito-Lay truths (evidence in `scripts/tmp-goupc-benchmark-report.md`): 028400199247 -> Doritos Flamin' Hot Nacho 9.75oz; 00028400076388 -> Lay's Kettle Cooked Original Party Size; 00028400160131 -> Lay's Barbecue 9.5oz; 00028400028141 -> Munchies Cheese Fix Snack Mix.
- [ ] **Step 2:** Add to the fixture `_comment` a line noting the 2026-07-08 correction + evidence file. Record the 2 suspect corpus rows (086699294739 pilot_alpin naming; 8859305548272 Arisun size) in `RISK_REGISTER.md` as data-quality items for the tire-corpus pipeline (corpus regeneration is out of scope here).
- [ ] **Step 3:** Run any grader test that consumes the fixture (`npx vitest run` full) -> green.  - [ ] **Step 4: Commit** — `fix(fixtures): correct 4 shifted Frito-Lay truths (Go-UPC benchmark evidence)`

### Task 16: Quota visibility

**Files:** Modify `src/app/api/ai-lookup/route.ts` (GET handler) + its test

- [ ] **Step 1: Failing test** — GET `/api/ai-lookup` response includes `goUpc: { configured: boolean, used: number, limit: number, warn: boolean }` (booleans/numbers only, never the key).
- [ ] **Step 2-5:** implement, pass, commit — `feat(api): Go-UPC quota visibility in ai-lookup status`

---

## Phase F — E2E proof (mocked, IS_E2E)

### Task 17: E2E ladder spec + screenshots

**Files:** Create `e2e/goupc-ladder.spec.ts`

- [ ] **Step 1:** Four scenarios via `page.route` on `/api/ai-lookup` (webServer already runs `IS_E2E=1`):
  1. Exact-hit mock -> scan unknown code -> feed row upgrades to Verified AI Decode and auto-counts; screenshot `e2e/proof/goupc-exact-autocount.png`.
  2. Inferred mock -> Needs Review suggestion with product attached; screenshot `goupc-inferred-suggest.png`.
  3. Cap-reached mock -> row reason contains "Go-UPC monthly cap reached"; screenshot `goupc-cap-reason.png`.
  4. All-providers-dead mock (route 500s) -> raw row persists in Needs Review after reload (count-first proof); screenshot `countfirst-survives.png`.
- [ ] **Step 2:** `npm run test:e2e -- goupc-ladder` -> PASS with screenshots in `e2e/proof/`.
- [ ] **Step 3: Commit** — `test(e2e): Go-UPC ladder proof (exact, inferred, cap, count-first)`

### Task 18: Bot gate

- [ ] **Step 1:** Run the Human Bot Proof Gate for resolution changes: `npm run qa:revision` (and `npm run qa:bots:live` only if the owner approves a live pass). Attach outputs; failures block handoff per `docs/REVISION_GATE.md`.
- [ ] **Step 2: Commit** any bot-driven fixes.

---

## Phase G — Staged live proof (owner-gated; HARD codes for tail rungs; lower-tier-model grading)

> Spend gates for the whole phase (each stated before running, per doctrine): Go-UPC <= 40 lookups (<1% quota, $0 marginal); Firecrawl <= 300 credits (~$0.25); GPT-5.5 <= $3.00 hard cap (same worst-case-reserving gate as `scripts/tmp-gpt-goupc-misses.mts`); grading agents run on SUBSCRIPTION models (haiku for mechanical grading, sonnet for adjudication) — $0 cash.

### Task 19: Rung-by-rung live micro-proofs (one by one, in isolation)

- [ ] **Step 1 (Rung 1, corpus, $0):** `scripts/proof-rung-corpus.mjs` — 20 random tire + 20 random retail barcodes from the knowledge DB through the REAL route (local dev server, live rung disabled via missing keys): assert 40/40 resolve locally, p50 < 5ms. Output JSON.
- [ ] **Step 2 (Rung 2, Go-UPC, <=15 lookups):** 10 known-good codes + 5 non-GTIN (assert the gate blocks them BEFORE the client: usage counter unchanged — this is the quota-protection proof). Reconcile counter vs Go-UPC console; record both numbers.
- [ ] **Step 3 (Rung 3, Fetch V2, HARD SET ONLY):** input = `scripts/tmp-goupc-200-misses.txt` MINUS the 13 Fetch V2 already resolved (i.e., the 61 double-miss codes) — production-tail realism per owner order; 20-code sample, WITH the new meros + brocade doors; compare resolution rate vs today's 17.6% baseline. Success = strictly more than baseline with zero wrong identities (graded vs corpus truth).
- [ ] **Step 4 (Rung 4, GPT v3 prompt, HARD SET ONLY, <= $3):** the same double-miss codes Fetch V2 still cannot resolve, 10-code sample through `gptFromScratch` with the v3 prompt; grade: junk-guess count must be ZERO (v2 baseline from today: 3 junk in 7), honest-empty allowed, any verified answer must match corpus. Wallet line per cost-truth rule.
- [ ] **Step 5:** Each micro-proof writes `scripts/proof-rung-<n>-results.json` + a `## Rung N` section in the proof report.

### Task 20: Full-ladder live run + lower-tier grading + final report

- [ ] **Step 1:** `scripts/proof-full-ladder.mjs` — 60 codes end-to-end through the real route with live keys: 20 corpus tires (expect rung 1), 20 fresh retail codes from the at-risk/loop pools (expect Go-UPC), 20 from the double-miss hard set (expect Fetch V2/GPT/NR). Caps from the phase header apply; resumable; raw archived.
- [ ] **Step 2 (lower-tier grading):** dispatch grading agents — haiku agents grade mechanical agreement (answer vs corpus/fixture truth, table out), sonnet agents adjudicate every disagreement and every tail-rung answer (same 4-agent pattern as the 2026-07-08 accuracy cross-check). No opus/fable graders — owner order: proof by lower-tier models.
- [ ] **Step 3 (final report):** PDF via reportlab (pattern: `scripts/tmp-goupc-200-report-pdf.py`), opened in Chrome + sent to owner. MUST contain, per owner order: per-rung what's WORKING / what's NOT / what to REMOVE or IMPROVE / what to ADD next (each with evidence), the ladder waterfall, accuracy tables, latency, and the wallet reconciliation ("computed floor; true spend = consoles").
- [ ] **Step 4:** Update `PROGRESS.md`, `TESTING.md`, `RISK_REGISTER.md`, `LESSONS_LEARNED.md`; write the reconciliation marker; update memory (`three-builds-shipped` successor entry).
- [ ] **Step 5: Commit** — `docs(proof): staged ladder proof + final report`

---

## Self-review notes

- Spec coverage: HARD RULE 0 (T9, T17.4), decisions 1-7 (T7-T9), non-GTIN path incl. Fetch-V2-first (T8), meros door (T11), prompt review resolved as v3 (T12), archive (T2, T13 wiring in T7), tenant trust (no new write path touches the global catalog — T9 store changes are tenant-local by construction; asserted in T9 store test), quota visibility (T16), purge (T14), cost truth (phase G header + wallet lines), corpus hygiene (T15), Gemini removal (T8).
- Owner orders folded in: tail rungs tested on double-miss HARD set only (T19.3-19.4); prefix-DB evaluated with the meros source (T13); prompt optimized (T12); proof by lower-tier models (T20.2); per-rung one-by-one then full ladder (T19 then T20); free/cheap tool adds: meros.io, brocade.io (free), prefix pages (free) — no new paid dependency anywhere.
- Type consistency: `GoUpcOutcome`/`GoUpcRungResult` names used consistently in T3/T7/T8; `canonicalGtin` consumed by T7 (cache key) and T9 (identity-merge).
