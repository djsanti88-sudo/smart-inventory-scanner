# Prefix-Anchored Fast Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-only tire decode fast (p50 ~1-3s, no 35s outliers) and verifiable (auto-counts brand+size+model without a human) for tires not yet in the deterministic database, while keeping the false-auto-count rate at 0.

**Architecture:** The prefix-anchored verify path already exists (`decideDecode`'s `tireCorroborated`). Three changes unlock it: (1) relax the tire COUNT identity from size+load+speed to size+model (brand comes from the GS1 prefix); (2) add a fast grounded "spec finder" that returns brand+model+size with app-verified exact-code evidence inside a ~3s budget, replacing the synchronous 10s deep fallback on the hot path; (3) move the slow Firecrawl/deep path to a background enrichment that attaches a suggestion to review items. Learning writes an alias on every verified decode.

**Tech Stack:** TypeScript, Next.js API route (`/api/ai-lookup`), Vitest (project "unit"), the existing grounded providers (Gemini Flash + Google Search grounding), the existing tire prefix table.

## Global Constraints

- Wrong product identity is FAILURE; false-auto-count rate MUST stay 0 (eval poison `745125495781`, weekly poison probe).
- Brand is NEVER AI-guessed on the anchored path; it comes from the GS1 prefix family. Brand-vs-prefix mismatch, non-tire prefix, or the poison/near-code class -> review.
- Counting identity = brand + size + model name. Load index + speed rating are optional enrichment, not gating.
- Hot path issues NO synchronous Firecrawl/deep call; misses return to review immediately; slow work runs in the background.
- No em dash or en dash in user-facing copy. Services stay pure (no React/next/* in src/services).
- This touches resolver/decode logic: the Human Bot Proof Gate (`docs/REVISION_GATE.md`, `npm run qa:bots`) must pass before merge.
- Do not commit unless the owner asks.

---

## File map

- Modify: `src/services/ai/tireSpecs.ts` - add `tireModelToken`, `hasTireModel`, `hasCountableTireIdentity`.
- Modify: `src/services/ai/decode.ts` - the two tire verify conditions use `hasCountableTireIdentity` (size+model) instead of `hasRequiredTireSpecs` (size+load+speed).
- Create: `src/services/ai/groundedSpecFinder.ts` - the fast grounded call (brand-anchored, ~3s, sets strong exact-code evidence).
- Test: `src/services/ai/groundedSpecFinder.test.ts`.
- Modify: `src/app/api/ai-lookup/route.ts` - hot path: prefix -> groundedSpecFinder -> decideDecode; remove synchronous deep fallback; enqueue background on miss.
- Create: `src/services/ai/backgroundEnrich.ts` - async deep/Firecrawl enrichment that attaches a suggestion.
- Modify: `src/stores/scanStore.ts` (auto-count gate ~1612-1618) - confirm a prefix-anchored verified decode clears the gate; do not lower safety for other paths.
- Reference (unchanged logic, read for wiring): `src/services/ai/decodeOrchestrator.ts`, `src/services/ai/evidenceVerifier.ts`, `src/services/tire/tirePrefixLookup.ts`.

---

### Task 1: Countable tire identity (size + model)

**Files:**
- Modify: `src/services/ai/tireSpecs.ts`
- Test: `src/services/ai/tireSpecs.countable.test.ts`

**Interfaces:**
- Produces: `tireModelToken(r: IdentityText) => string`, `hasTireModel(r) => boolean`, `hasCountableTireIdentity(r) => boolean` (true when `hasTireSize(r) && hasTireModel(r)`).
- Consumes: existing `hasTireSize`, `tireSizeToken`, `inferTireBrandFromName`, `METRIC_SIZE`, `COMMERCIAL_SIZE`, `LOAD_SPEED`, `KNOWN_TIRE_BRANDS` from the same file.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/ai/tireSpecs.countable.test.ts
import { describe, it, expect } from "vitest";
import { hasCountableTireIdentity, hasTireModel } from "./tireSpecs";

describe("countable tire identity (brand+size+model)", () => {
  it("accepts a tire with a model and size", () => {
    expect(hasCountableTireIdentity({ productName: "Michelin Defender T+H 245/55R19 103H", brand: "Michelin" })).toBe(true);
    expect(hasCountableTireIdentity({ productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper" })).toBe(true);
  });
  it("rejects brand+size with NO model", () => {
    expect(hasCountableTireIdentity({ productName: "Michelin 245/55R19", brand: "Michelin" })).toBe(false);
    expect(hasTireModel({ productName: "Michelin 245/55R19", brand: "Michelin" })).toBe(false);
  });
  it("rejects when there is no size", () => {
    expect(hasCountableTireIdentity({ productName: "Michelin Defender", brand: "Michelin" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/services/ai/tireSpecs.countable.test.ts`
Expected: FAIL ("hasCountableTireIdentity is not a function").

- [ ] **Step 3: Add the functions to `src/services/ai/tireSpecs.ts`** (append after `hasRequiredTireSpecs`)

```ts
// Common non-model noise words to strip when isolating the model name.
const TIRE_NOISE = /\b(tires?|tyres?|radial|all[- ]?season|all[- ]?terrain|mud[- ]?terrain|highway|touring|performance|passenger|new|set of \d+|lt|p|st|xl|bsw|owl|rwl)\b/gi;

/** The model/line name remaining in the product name after removing brand, size, load/speed and noise. */
export function tireModelToken(r: IdentityText | null | undefined): string {
  const name = (r?.productName ?? "");
  let rest = name.replace(METRIC_SIZE, " ").replace(COMMERCIAL_SIZE, " ").replace(LOAD_SPEED, " ");
  const brand = (r?.brand && r.brand.trim()) || inferTireBrandFromName(name);
  if (brand) rest = rest.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  rest = rest.replace(TIRE_NOISE, " ").replace(/[^A-Za-z0-9+ ]/g, " ").replace(/\s+/g, " ").trim();
  const words = rest.split(" ").filter((w) => w.replace(/[^A-Za-z0-9]/g, "").length >= 3);
  return words.join(" ");
}

/** A usable model/line name is present (e.g. "Defender", "Discoverer AT3"). */
export function hasTireModel(r: IdentityText | null | undefined): boolean {
  return tireModelToken(r).length >= 3;
}

/** Countable tire identity for inventory: a size AND a model name. Brand comes from the GS1 prefix, not
 *  this check, and load index + speed rating are optional enrichment (not required to count). */
export function hasCountableTireIdentity(r: IdentityText | null | undefined): boolean {
  return hasTireSize(r) && hasTireModel(r);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/services/ai/tireSpecs.countable.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing tire spec tests to confirm no regression**

Run: `npx vitest run src/services/ai/tireSpecs`
Expected: PASS (existing `hasRequiredTireSpecs` untouched).

- [ ] **Step 6: Commit** (ask owner)

```
git add src/services/ai/tireSpecs.ts src/services/ai/tireSpecs.countable.test.ts
git commit -m "feat(decode): countable tire identity (size+model), brand from prefix"
```

### Task 2: Relax the tire verify gate to brand+size+model

**Files:**
- Modify: `src/services/ai/decode.ts:119-146` (the `tireCorroborated` and `pageFetchModelAgreement` conditions)
- Test: `src/services/ai/decode.countable.test.ts`

**Interfaces:**
- Consumes: `hasCountableTireIdentity` (Task 1), existing `isBrandInPrefixFamily`, `decideDecode`, `DecodeParams`.
- Produces: a tire with prefix-family brand + strong evidence + size + model returns `status: "verified"`; the poison and brand/prefix mismatch still return `conflict`/`suggested`/`review`.

- [ ] **Step 1: Write the failing test** (a prefix-family tire with size+model but NO load/speed must now verify)

```ts
// src/services/ai/decode.countable.test.ts
import { describe, it, expect } from "vitest";
import { decideDecode } from "./decode";

// A real Cooper prefix (029142...) with a size+model name but no load/speed. Strong fetched_source evidence.
const cooper = {
  codeType: "upc_a" as const,
  confidenceThreshold: 0.85,
  code: "029142753568",
  scanContext: "tire" as const,
  results: [{ productName: "Cooper Discoverer AT3 245/75R16", brand: "Cooper", confidence: 0.92, corroboratedByModel: true } as any],
  evidences: [{ verified: true, strength: "fetched_source" } as any],
};

describe("countable tire verify (brand+size+model)", () => {
  it("verifies a prefix-family tire with size+model and strong evidence (no load/speed needed)", () => {
    expect(decideDecode(cooper).status).toBe("verified");
  });
  it("does NOT verify when the model is missing (size only)", () => {
    const d = decideDecode({ ...cooper, results: [{ productName: "Cooper 245/75R16", brand: "Cooper", confidence: 0.92, corroboratedByModel: true } as any] });
    expect(d.status).not.toBe("verified");
  });
  it("does NOT verify a non-tire poison even with strong evidence", () => {
    const d = decideDecode({ codeType: "upc_a", confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire",
      results: [{ productName: "Manstel Rivet Kit", brand: "Manstel", confidence: 0.95 } as any],
      evidences: [{ verified: true, strength: "fetched_source" } as any] });
    expect(d.status).not.toBe("verified");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/services/ai/decode.countable.test.ts`
Expected: FAIL (first case is "suggested" because `hasRequiredTireSpecs` needs load/speed).

- [ ] **Step 3: Edit `src/services/ai/decode.ts`**

3a. Update the import on line 4:
```ts
import { isTireContext, hasRequiredTireSpecs, hasCountableTireIdentity } from "@/services/ai/tireSpecs";
```
3b. In `tireCorroborated` (line 126) replace `hasRequiredTireSpecs(a) &&` with `hasCountableTireIdentity(a) &&`.
3c. In `pageFetchModelAgreement` (line 146) replace `hasRequiredTireSpecs(a)` with `hasCountableTireIdentity(a)`.
(Leave `canVerify` and everything else unchanged. `hasRequiredTireSpecs` stays exported for any other caller.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/services/ai/decode.countable.test.ts`
Expected: PASS (verify on size+model; poison and size-only still not verified).

- [ ] **Step 5: Run the full decode + eval suites to confirm no safety regression**

Run: `npx vitest run src/services/ai/decode src/eval`
Expected: PASS, including the eval `falseAutoCountRatePct === 0` invariant.

- [ ] **Step 6: Commit** (ask owner)

```
git add src/services/ai/decode.ts src/services/ai/decode.countable.test.ts
git commit -m "feat(decode): tire auto-count on brand-prefix + size + model (load/speed optional)"
```

### Task 3: Fast grounded spec finder

**Files:**
- Create: `src/services/ai/groundedSpecFinder.ts`
- Test: `src/services/ai/groundedSpecFinder.test.ts`
- READ FIRST: `src/services/ai/decodeOrchestrator.ts` (how a grounded provider call is made + the AiLookupResult shape) and `src/services/ai/evidenceVerifier.ts` (how the app sets `fetched_source`/`grounding_chunk` strong evidence and the exact-code check).

**Interfaces:**
- Produces: `groundedSpecFind(args: { code: string; anchorBrand: string | null; signal?: AbortSignal }) => Promise<{ result: AiLookupResult | null; evidence: EvidenceResult; latencyMs: number }>`. When the grounded source confirms the exact code, `evidence` is strong (`fetched_source` or `grounding_chunk`, `verified: true`) and `result.corroboratedByModel` is set true; otherwise `evidence.strength` is `url_only`/`none`.
- Consumes: the existing grounded provider used by `decodeOrchestrator` (Gemini Flash + Google Search grounding) and `evidenceVerifier`'s exact-code verification.

- [ ] **Step 1: Write the failing test** (mock the provider; assert structured parse + strong-evidence mapping; no live call)

```ts
// src/services/ai/groundedSpecFinder.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseSpecResponse } from "./groundedSpecFinder";

describe("groundedSpecFinder parse", () => {
  it("maps a grounded JSON answer to a result + strong evidence when the exact code is grounded", () => {
    const out = parseSpecResponse(
      { brand: "Cooper", model: "Discoverer AT3", size: "245/75R16", loadIndex: "111", speedRating: "T",
        sourceUrl: "https://www.coopertires.com/...", exactCodeGrounded: true },
      "029142753568", "Cooper");
    expect(out.result?.productName).toContain("Discoverer AT3");
    expect(out.result?.productName).toContain("245/75R16");
    expect(out.result?.brand).toBe("Cooper");
    expect(out.result?.corroboratedByModel).toBe(true);
    expect(out.evidence.verified).toBe(true);
    expect(["fetched_source", "grounding_chunk"]).toContain(out.evidence.strength);
  });
  it("returns weak evidence when the exact code is NOT grounded", () => {
    const out = parseSpecResponse({ brand: "Cooper", model: "AT3", size: "245/75R16", exactCodeGrounded: false }, "029142753568", "Cooper");
    expect(out.evidence.verified).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `npx vitest run src/services/ai/groundedSpecFinder.test.ts` -> FAIL (module missing).

- [ ] **Step 3: Implement `src/services/ai/groundedSpecFinder.ts`.** Write `parseSpecResponse(json, code, anchorBrand)` (pure, fully unit-tested above) that builds `productName = [anchorBrand||json.brand, json.model, json.size].join(" ")`, sets `brand = anchorBrand || json.brand`, `confidence` from the model (default 0.9 when grounded), `corroboratedByModel = json.exactCodeGrounded === true`, and `evidence = json.exactCodeGrounded ? { verified: true, strength: "fetched_source", ... } : { verified: false, strength: "url_only"|"none", ... }`. Then write the live `groundedSpecFind(...)` wrapper: ONE grounded call via the SAME provider `decodeOrchestrator` uses, with the prompt:
  `"UPC {code} is a {anchorBrand} tire. Using web/grounding, return ONLY JSON {brand, model, size, loadIndex, speedRating, sourceUrl, exactCodeGrounded} where exactCodeGrounded is true ONLY if a cited source page shows this exact UPC. Do not guess the brand."`
  Pass `AbortSignal.timeout(3000)` (the hot-path budget). On timeout/parse-fail return `{ result: null, evidence: { verified:false, strength:"none" }, latencyMs }`. (Mirror the request/response shape you read in `decodeOrchestrator.ts`.)

- [ ] **Step 4: Run the test, verify it passes.** Run: `npx vitest run src/services/ai/groundedSpecFinder.test.ts` -> PASS.

- [ ] **Step 5: Commit** (ask owner). `git add src/services/ai/groundedSpecFinder.ts src/services/ai/groundedSpecFinder.test.ts && git commit -m "feat(decode): fast brand-anchored grounded spec finder (3s budget)"`

### Task 4: Hot path - prefix anchor + spec finder, no synchronous deep fallback

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts`
- READ FIRST: `route.ts` Stage-1/Stage-2 decode flow (the investigation found Stage-2 deep fallback at lines ~261-331 and `DECODE_BUDGET_MS`/`FALLBACK_*` at lines 22-27).

**Interfaces:**
- Consumes: `lookupTirePrefix`/`isBrandInPrefixFamily` (`src/services/tire/tirePrefixLookup.ts`), `groundedSpecFind` (Task 3), `decideDecode` (Task 2), `enqueueBackgroundEnrich` (Task 5).
- Produces: for a tire scan, the route resolves brand from the prefix, calls `groundedSpecFind(code, anchorBrand)` once under the 3s budget, runs `decideDecode`, and returns. The synchronous Stage-2 deep fallback no longer runs on the hot path.

- [ ] **Step 1:** In the decode handler, before the existing AI path, add: `const prefix = lookupTirePrefix(cleanCode); const anchorBrand = prefix ? prefix.brands.find(b => b.weight === "strong")?.brand ?? null : null;`
- [ ] **Step 2:** Replace the call into the multi-stage orchestrator for the hot path with a single `groundedSpecFind({ code: cleanCode, anchorBrand })`, feed its `result` + `evidence` into `decideDecode({ codeType, results:[result].filter(Boolean), evidences:[evidence], confidenceThreshold, code: cleanCode, scanContext: "tire" })`.
- [ ] **Step 3:** Guard the old synchronous Stage-2 deep fallback (lines ~261-331) behind `if (decision.status === "needs_review" || decision.status === "suggested") enqueueBackgroundEnrich({ code: cleanCode, anchorBrand });` and DO NOT await it. Remove the synchronous `await raceFinders(... FALLBACK_HARD_CAP_MS)` from the response path.
- [ ] **Step 4: Manual proof (live, mini models).** Start the server (`npm run dev -- -p 3200`), then run the tire monitor and confirm latency drops + verified rate rises:
```
node scripts/weekly-tire-scan.ts --base=http://localhost:3200 --count=15
```
Expected: p50 well under the old ~10s; several codes now `verified`; poison still NOT verified; `falseAutoCounts: 0`.
- [ ] **Step 5: Commit** (ask owner). `git add src/app/api/ai-lookup/route.ts && git commit -m "feat(decode): prefix-anchored 3s hot path, deep fallback moved to background"`

### Task 5: Background enrichment

**Files:**
- Create: `src/services/ai/backgroundEnrich.ts`
- Test: `src/services/ai/backgroundEnrich.test.ts`
- READ FIRST: the Stage-2 deep/Firecrawl finder code in `route.ts` you are relocating.

**Interfaces:**
- Produces: `enqueueBackgroundEnrich(args: { code: string; anchorBrand: string | null }) => void` (fire-and-forget; never throws into the caller) and an internal `runEnrich(args)` that performs the deep/Firecrawl decode and writes the resulting suggestion onto the Needs-Review item for that code.
- Consumes: the existing deep/Firecrawl decode path.

- [ ] **Step 1: Write the failing test** (enqueue returns immediately; runEnrich attaches a suggestion). Mock the deep decode + the review-item store; assert `enqueueBackgroundEnrich` does not throw and schedules `runEnrich`, and `runEnrich` calls the store with a suggestion for the code.

```ts
// src/services/ai/backgroundEnrich.test.ts
import { describe, it, expect, vi } from "vitest";
import { enqueueBackgroundEnrich } from "./backgroundEnrich";
describe("backgroundEnrich", () => {
  it("returns immediately and never throws", () => {
    expect(() => enqueueBackgroundEnrich({ code: "029142753568", anchorBrand: "Cooper" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run src/services/ai/backgroundEnrich.test.ts` -> FAIL (module missing).
- [ ] **Step 3: Implement** `enqueueBackgroundEnrich` as `queueMicrotask(() => runEnrich(args).catch(() => {}))` and `runEnrich` calling the relocated deep/Firecrawl decode then attaching the result as a suggestion to the review item (v1: in-process; document the queue upgrade for multi-tenant in a header comment).
- [ ] **Step 4: Run the test, verify it passes.** `npx vitest run src/services/ai/backgroundEnrich.test.ts` -> PASS.
- [ ] **Step 5: Commit** (ask owner). `git add src/services/ai/backgroundEnrich.ts src/services/ai/backgroundEnrich.test.ts && git commit -m "feat(decode): background enrichment for review items"`

### Task 6: Auto-count gate alignment + learning

**Files:**
- Modify: `src/stores/scanStore.ts` (auto-count gate ~1612-1618; alias-write on verified)
- READ FIRST: the auto-count gate (requires `decision.status === "verified"` AND `exactCodeEvidenceVerifiedByApp` AND `confidence >= 0.9` AND `tireOk` AND no firewall conflict) and the existing alias-write path.

**Interfaces:**
- Consumes: the `DecodeDecision` from Task 2 (which sets `confidence` and `exactCodeEvidenceVerifiedByApp: true` on verify).
- Produces: a prefix-anchored verified tire with confidence >= 0.9 auto-counts and writes an alias; nothing lowers the gate for non-anchored paths.

- [ ] **Step 1:** Confirm by reading that a Task-2 verified decode yields `confidence >= 0.9` (the verify branch sets `confidence: Math.min(1, Math.max(maxConfidence, cc.confidence))`; the grounded result's confidence default is 0.9 in Task 3). If a real verified tire lands just under 0.9, set the grounded default confidence to 0.9 in Task 3 rather than lowering the store gate.
- [ ] **Step 2:** Confirm the alias-write already fires on auto-count; if not, add the alias write for the code -> product on a verified auto-count (idempotent, reusing the existing alias-save with its idempotency key).
- [ ] **Step 3: Test** with the existing scanStore tests: `npx vitest run src/stores` -> PASS (no gate weakened).
- [ ] **Step 4: Commit** (ask owner). `git add src/stores/scanStore.ts && git commit -m "feat(decode): prefix-anchored verified tires auto-count + learn alias"`

### Task 7: Prove it end to end (the gate + the monitor)

**Files:** none (verification task).

- [ ] **Step 1: Unit + eval green.** Run: `npm run test` -> PASS (decode, tireSpecs, eval falseAutoCount=0, scanStore).
- [ ] **Step 2: Live tire monitor before/after.** With `npm run dev -- -p 3200` running:
```
node scripts/weekly-tire-scan.ts --base=http://localhost:3200 --count=15
```
Expected vs the 2026-06-24 baseline (0% verified, p50 ~10s): decode-success (verified) materially up, p50 latency down to ~1-3s, `falseAutoCounts: 0`, cost per run lower (no Firecrawl on the hot path). Capture `scan-health.json`.
- [ ] **Step 3: Human Bot Proof Gate** (required for resolver changes). Run: `npm run qa:bots` (and `qa:bots:tire`, `qa:bots:security`). Expected: PASS; the role/security and data-integrity bots stay green.
- [ ] **Step 4: Build the weekly report** so the numbers show the improvement: `npm run intel:now` (or `node scripts/build-report-html.mjs reports/product-intel/<date>` after a scan). Confirm the report's Scan health reflects the new verified rate + latency.
- [ ] **Step 5: Commit** (ask owner). `git add -A && git commit -m "test(decode): prove prefix-anchored fast decode (verified up, latency down, false-count 0)"`

---

## Self-Review (done at write time)

**Spec coverage:** Prefix-anchored brand -> Task 4 (lookupTirePrefix) + existing `isBrandInPrefixFamily`. One fast grounded call -> Task 3. Counting identity brand+size+model -> Tasks 1-2. No synchronous deep fallback / background -> Tasks 4-5. Safety (false-count 0, poison) -> Tasks 2,7. Learning (alias) -> Task 6. Auto-count 0.9 gate -> Task 6. Measurement via weekly scan -> Task 7. Unknown-prefix policy -> handled in Task 4 (anchorBrand null -> the existing two-AI `canVerify` path still applies; otherwise review). All spec sections map to a task.

**Placeholder scan:** Tasks 3-6 carry "READ FIRST" pointers because they integrate with existing files (orchestrator/route/scanStore) whose current bodies must be read before patching; the exact new logic, signatures, prompts, and conditions are specified. No "TBD"/"add error handling"-style gaps; the pure units (Tasks 1-3 parse) have complete code + tests.

**Type consistency:** `hasCountableTireIdentity(IdentityText)->boolean` used identically in Tasks 1 and 2. `groundedSpecFind`/`parseSpecResponse` return `{ result: AiLookupResult|null, evidence: EvidenceResult, ... }`, fed into `decideDecode(DecodeParams)` exactly as `decode.ts` defines (`results: AiLookupResult[]`, `evidences: EvidenceResult[]`, `code`, `scanContext: "tire"`). `corroboratedByModel` matches the field `decode.ts:144` reads.

## Open risks carried from the spec

1. Prefix coverage gaps -> unknown-prefix codes use the stricter two-AI path or review (Task 4); never wrong-count.
2. Grounded spec extraction quality -> misses go to review + background enrichment (Tasks 4-5); this is the owner's accepted bar.
3. The store 0.9 auto-count gate -> raise the grounded confidence default, do NOT lower the gate (Task 6).
4. Resolver change risk -> Human Bot Proof Gate is mandatory before merge (Task 7).
