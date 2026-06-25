# Instant Scan + Internet-Only Background Size Fill - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tire scan return the brand instantly (no AI wait), fill the size from two independent Internet sources in the background, and auto-count only when those two sources AGREE on the size - never reading the local 30k DB.

**Architecture:** Two clocks. Clock 1: the prefix-anchored hot path returns the brand immediately with no synchronous grounded call. Clock 2: the client's background verify runs two INDEPENDENT retrieval roads (Gemini grounded search + a direct page fetch) under an 8s cap, returns the size on first valid result, and sets a `sizeAgreement` flag when both roads land the same size; a new `decideDecode` route auto-counts on that agreement; the store gate is relaxed to honor it.

**Tech Stack:** Next.js 16 (App Router) route handlers, TypeScript, Zustand store, Vitest (node + jsdom projects), Playwright + `qa:bots` for human-bot proof.

## Global Constraints

- No em dash or en dash in user-facing copy or code comments. Use normal punctuation.
- false-auto-count MUST stay 0: the existing poison (Manstel rivet kit `745125495781`) and every non-tire / single-source / weak-prefix case must never auto-count.
- The local 30k tire DB (`data/tire-knowledge/tire_corpus_flat.csv`) is NEVER read in the decode/auto-count path. No script under `src/app`, `src/services`, `src/stores` may read it.
- Automated tests NEVER call live Gemini/OpenAI: mock `fetch`/the engines; E2E mocks `/api/ai-lookup` and runs with `IS_E2E=1`.
- API keys are read server-side only (`process.env.*`), never in client code.
- Keep services pure and testable outside React (no React / `next/*` imports in `src/services`).
- The decoder uses only the prefix table (public GS1 facts) + the Internet. Two INDEPENDENT Internet sources agreeing is the entire size auto-count gate.
- Run the full safety sweep after every task: `npx vitest run src/services/ai/decode src/services/ai/decodeCorroboration src/services/tire src/eval scripts/__tests__/mined-prefix-sanity.test.mjs`.

---

### Task 1: Mine the SIZE from the description in `parseSpecResponse`

**Files:**
- Modify: `src/services/ai/groundedSpecFinder.ts` (function `parseSpecResponse`, lines ~30-89)
- Test: `src/services/ai/groundedSpecFinder.test.ts`

**Interfaces:**
- Consumes: `tireSizeToken(r: IdentityText)` from `src/services/ai/tireSpecs.ts` (returns the normalized size token like `"265/70R17"`, or `""`).
- Produces: `parseSpecResponse(json, anchorBrand)` still returns `{ result: AiLookupResult | null }`, but `result.specsShort` now carries a size even when the model put it only in `model`/`productName`/free text, not a clean `size` field.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/services/ai/groundedSpecFinder.test.ts
import { parseSpecResponse } from "./groundedSpecFinder";

it("mines the size from the model/description when the size field is empty", () => {
  const json = { brand: "Toyo", model: "Open Country A/T III 265/70R17", size: "" };
  const { result } = parseSpecResponse(json, "Toyo");
  expect(result).not.toBeNull();
  expect(result!.specsShort).toContain("265/70R17");
});

it("still prefers an explicit size field when present", () => {
  const json = { brand: "Toyo", model: "Open Country", size: "265/70R17" };
  const { result } = parseSpecResponse(json, "Toyo");
  expect(result!.specsShort).toContain("265/70R17");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/ai/groundedSpecFinder.test.ts`
Expected: FAIL on the first test (specsShort has no size because `model` was not scanned).

- [ ] **Step 3: Implement the minimal change**

In `parseSpecResponse`, after the existing `const size = j.size ? String(j.size) : "";` line, add a fallback that mines the size from the other fields using the project's size matcher. Import at top of file:

```ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
```

Replace the `size` derivation with:

```ts
const rawSize = j.size ? String(j.size) : "";
// The size often lives in the title/description, not a clean size field. Mine it from the model name
// and product text when the structured field is missing (owner insight).
const size = rawSize || tireSizeToken({
  productName: [j.brand, j.model, j.productName, j.description].filter(Boolean).map(String).join(" "),
} as Parameters<typeof tireSizeToken>[0]);
```

(Leave the rest of the function unchanged - `specsShort` is already built from `size`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/services/ai/groundedSpecFinder.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/groundedSpecFinder.ts src/services/ai/groundedSpecFinder.test.ts
git commit -m "feat(tires): mine tire size from the grounded description, not just a size field"
```

---

### Task 2: Point the grounded finder at a LIVE model

**Files:**
- Modify: `src/services/ai/groundedSpecFinder.ts` line ~101-102 (`GROUNDED_SPEC_GEMINI_MODEL`)
- Test: `src/services/ai/groundedSpecFinder.test.ts`

**Interfaces:**
- Produces: `GROUNDED_SPEC_GEMINI_MODEL` exported constant so a test can assert the default is a live model id.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/services/ai/groundedSpecFinder.test.ts
import { GROUNDED_SPEC_GEMINI_MODEL } from "./groundedSpecFinder";

it("defaults to a live Gemini model, not the retired gemini-2.0-flash-001", () => {
  expect(GROUNDED_SPEC_GEMINI_MODEL).not.toBe("gemini-2.0-flash-001");
  expect(GROUNDED_SPEC_GEMINI_MODEL).toMatch(/^gemini-2\.5-flash/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/ai/groundedSpecFinder.test.ts -t "live Gemini model"`
Expected: FAIL - constant is currently `gemini-2.0-flash-001` and is not exported.

- [ ] **Step 3: Implement**

In `groundedSpecFinder.ts`, export the constant and change the default:

```ts
export const GROUNDED_SPEC_GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/services/ai/groundedSpecFinder.test.ts -t "live Gemini model"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/groundedSpecFinder.ts src/services/ai/groundedSpecFinder.test.ts
git commit -m "fix(tires): grounded spec finder used a retired model (gemini-2.0-flash-001) -> gemini-2.5-flash"
```

---

### Task 3: `sizeAgreement` field + `decideDecode` `internet_two_source_size` route

**Files:**
- Modify: `src/types.ts` (interface `AiLookupResult` - add `sizeAgreement?: boolean`; type `DecodeDecision.corroborationPath` union - add `"internet_two_source_size"`)
- Modify: `src/services/ai/decode.ts` (`decideDecode`, lines ~119-163)
- Test: `src/services/ai/decodeCorroboration.test.ts`

**Interfaces:**
- Consumes: `isBrandInPrefixFamily(code, brand, { strongOnly: true })`, `isTireContext(a)`, `hasCountableTireIdentity(a)` (already imported in `decode.ts`).
- Produces: a new verify branch `internetTwoSourceSize`; when it fires, `decideDecode` returns `{ status: "verified", corroborationPath: "internet_two_source_size", exactCodeEvidenceVerifiedByApp: false }`. The store (Task 5) reads `corroborationPath` to allow the count.

- [ ] **Step 1: Write the failing tests**

```ts
// add a describe block to src/services/ai/decodeCorroboration.test.ts
// reuse the file's existing helpers: tire(), strongEv(), weakEv()
describe("decideDecode - PATH 3 internet two-source size agreement (no exact-code echo, no DB)", () => {
  const sizeAgreed = (over = {}) =>
    tire({ productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", specsShort: "LT245/75R16 120R", sizeAgreement: true, ...over });

  it("AUTO-VERIFIES a strong-prefix tire when two independent sources agree on the size - WITHOUT exact-code evidence", () => {
    const r = decideDecode({ codeType: "upc_a", results: [sizeAgreed()], evidences: [weakEv()], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.corroborationPath).toBe("internet_two_source_size");
  });

  it("stays SUGGESTED when only ONE source has the size (no agreement)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [sizeAgreed({ sizeAgreement: false })], evidences: [weakEv()], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify the poison (non-tire) even with sizeAgreement true", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "", sizeAgreement: true })], evidences: [weakEv()], confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify a brand NOT in the strong prefix family even with sizeAgreement", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Kumho Crugen 265/70R17 115T", brand: "Kumho", specsShort: "265/70R17 115T", sizeAgreement: true })], evidences: [weakEv()], confidenceThreshold: 0.85, code: "012345678905", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/ai/decodeCorroboration.test.ts -t "internet two-source"`
Expected: FAIL - `sizeAgreement` is not a known field and the route does not exist (first test gets "suggested").

- [ ] **Step 3: Add the type fields**

In `src/types.ts`, add to `interface AiLookupResult` (next to `corroboratedByModel`):

```ts
  // Two INDEPENDENT Internet retrievals (grounded search + page fetch) agreed on the tire SIZE. Set by
  // the background size race in the route; consumed by decideDecode's internet_two_source_size branch.
  sizeAgreement?: boolean;
```

In the `DecodeDecision` type, extend the `corroborationPath` union to include `"internet_two_source_size"`.

- [ ] **Step 4: Add the verify route in `decideDecode`**

In `src/services/ai/decode.ts`, after the `pageFetchModelAgreement` block (line ~146), add:

```ts
  // PATH 3 - INTERNET TWO-SOURCE SIZE AGREEMENT. The barcode's STRONG brand-prefix family gives the brand
  // deterministically (public GS1 fact, not the AI text). When two INDEPENDENT Internet retrievals (grounded
  // search + a direct page fetch) agreed on the SIZE (a.sizeAgreement, set by the route race), that
  // agreement is the second source - so we do NOT require the exact code echoed on a page. The local DB is
  // never consulted. Poison / non-tire / weak-prefix / single-source can never satisfy it.
  const internetTwoSourceSize =
    scanContext === "tire" &&
    isPublicBarcode &&
    identityNonEmpty &&
    passesThreshold &&
    !!a &&
    a.sizeAgreement === true &&
    isTireContext(a) &&
    hasCountableTireIdentity(a) &&
    !!code &&
    isBrandInPrefixFamily(code, a.brand, { strongOnly: true });
```

Update the verify gate condition and the `corroborationPath`:

```ts
  if (canVerify || tireCorroborated || pageFetchModelAgreement || internetTwoSourceSize) {
    const corroborationPath = canVerify
      ? "two_ai_agreement"
      : tireCorroborated
        ? "deterministic_prefix"
        : pageFetchModelAgreement
          ? "page_fetch_model_agreement"
          : "internet_two_source_size";
    return {
      status: "verified",
      confidence: Math.min(1, Math.max(maxConfidence, cc.confidence)),
      reason: canVerify
        ? "Verified AI Decode: both providers independently agree and the app confirmed the exact code in real evidence."
        : tireCorroborated
          ? "Verified AI Decode: tire corroborated by the barcode's strong brand-prefix family + size + model + app-verified exact code (independent of the AI text)."
          : pageFetchModelAgreement
            ? "Verified AI Decode: the app's page-fetch and an independent model read agree on the tire identity, with size + model + app-verified exact code."
            : "Verified AI Decode: brand from the strong GS1 prefix and two independent Internet sources agree on the size.",
      evidenceStrength: bestEvidence.strength,
      // internet_two_source_size verifies WITHOUT an app-confirmed exact code; the size agreement is the
      // second source. The store gate (scanStore) honors this path explicitly.
      exactCodeEvidenceVerifiedByApp: canVerify || tireCorroborated || pageFetchModelAgreement,
      crossCheck: baseCrossCheck,
      corroborationPath,
    };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/ai/decodeCorroboration.test.ts`
Expected: PASS (all, including the existing suites - the new route does not affect them).

- [ ] **Step 6: Run the safety sweep**

Run: `npx vitest run src/services/ai/decode src/services/ai/decodeCorroboration src/services/tire src/eval scripts/__tests__/mined-prefix-sanity.test.mjs`
Expected: PASS, false-auto-count still 0 (poison stays blocked).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/services/ai/decode.ts src/services/ai/decodeCorroboration.test.ts
git commit -m "feat(tires): add internet_two_source_size verify route (size agreement, no exact-code echo, no DB)"
```

---

### Task 4: Two-arm independent size race in the route (decode-deep)

**Files:**
- Create: `src/services/ai/sizeRace.ts` (pure-ish orchestrator + a pure `agreeOnSize` helper)
- Modify: `src/app/api/ai-lookup/route.ts` (the `mode: "decode-deep"` / deep path that runs `enrichWithPageFetch`)
- Test: `src/services/ai/sizeRace.test.ts`

**Interfaces:**
- Consumes: `tireSizeToken` (tireSpecs.ts); `groundedSpecFind({ code, codeType, anchorBrand, signal })` (Arm A, returns `{ result, evidence }`); `enrichWithPageFetch(...)` (Arm B, already used in the deep path) - read its current call in `route.ts` for the exact args.
- Produces: `agreeOnSize(a: string | undefined, b: string | undefined): boolean` (pure: true only when both normalize to the same non-empty tire size token); and a `runSizeRace({...})` that returns `{ size: string; sizeAgreement: boolean; armA; armB }`. The route sets `result.sizeAgreement` from it before calling `decideDecode`.

- [ ] **Step 1: Write the failing test for the pure helper**

```ts
// src/services/ai/sizeRace.test.ts
import { describe, it, expect } from "vitest";
import { agreeOnSize } from "./sizeRace";

describe("agreeOnSize - independent two-source size agreement", () => {
  it("true only when both sources land the same normalized size", () => {
    expect(agreeOnSize("265/70R17", "265/70R17")).toBe(true);
    expect(agreeOnSize("265/70 R17", "265/70R17")).toBe(true); // normalized equal
  });
  it("false on disagreement or a missing source", () => {
    expect(agreeOnSize("265/70R17", "235/75R17")).toBe(false);
    expect(agreeOnSize("265/70R17", "")).toBe(false);
    expect(agreeOnSize("", "")).toBe(false);
    expect(agreeOnSize(undefined, "265/70R17")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/services/ai/sizeRace.test.ts`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Implement `agreeOnSize` + `runSizeRace`**

```ts
// src/services/ai/sizeRace.ts
import "server-only";
import { tireSizeToken } from "@/services/ai/tireSpecs";

/** True only when two sources land the SAME non-empty normalized tire size. Pure. */
export function agreeOnSize(a: string | undefined, b: string | undefined): boolean {
  const sa = tireSizeToken({ productName: a ?? "" } as Parameters<typeof tireSizeToken>[0]);
  const sb = tireSizeToken({ productName: b ?? "" } as Parameters<typeof tireSizeToken>[0]);
  return !!sa && !!sb && sa === sb;
}

export interface SizeRaceArm { size: string; ok: boolean; }
export interface SizeRaceResult { size: string; sizeAgreement: boolean; armA: SizeRaceArm; armB: SizeRaceArm; }

/**
 * Run two INDEPENDENT retrieval roads concurrently under one 8s budget. armAGetSize and armBGetSize each
 * resolve to a size string (or "") - they are DIFFERENT roads (grounded search vs page fetch). First valid
 * size becomes the display size; sizeAgreement is true only when BOTH return the same normalized size.
 */
export async function runSizeRace(args: {
  armAGetSize: (signal: AbortSignal) => Promise<string>;
  armBGetSize: (signal: AbortSignal) => Promise<string>;
  budgetMs?: number;
}): Promise<SizeRaceResult> {
  const { armAGetSize, armBGetSize, budgetMs = 8000 } = args;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const [a, b] = await Promise.all([
      armAGetSize(ctrl.signal).catch(() => ""),
      armBGetSize(ctrl.signal).catch(() => ""),
    ]);
    const armA: SizeRaceArm = { size: a || "", ok: !!a };
    const armB: SizeRaceArm = { size: b || "", ok: !!b };
    const sizeAgreement = agreeOnSize(a, b);
    const size = a || b || "";
    return { size, sizeAgreement, armA, armB };
  } finally {
    clearTimeout(to);
  }
}
```

- [ ] **Step 4: Run the pure test to verify it passes**

Run: `npx vitest run src/services/ai/sizeRace.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the race into the deep path**

In `route.ts`, in the `mode: "decode-deep"` branch (the path that currently calls `enrichWithPageFetch`), after obtaining the page-fetch result (Arm B) and the anchor brand: call `runSizeRace` with Arm A = `groundedSpecFind` size and Arm B = the page-fetch result size (extract via `tireSizeToken` over the page result's `productName`/`specsShort`). Set `result.sizeAgreement = race.sizeAgreement` on the chosen `result` before `decideDecode`. Read the surrounding `decode-deep` code for the exact `result` variable and where `decideDecode` is called; the only new lines are: build the two arm thunks, `const race = await runSizeRace({...})`, and `result.sizeAgreement = race.sizeAgreement`. Keep the two arms genuinely different roads (grounded vs page fetch) - do NOT use two grounded calls.

- [ ] **Step 6: Add an integration test (mocked arms)**

```ts
// src/services/ai/sizeRace.test.ts - add
import { runSizeRace } from "./sizeRace";
it("sets sizeAgreement true when both roads return the same size, false otherwise", async () => {
  const agree = await runSizeRace({ armAGetSize: async () => "265/70R17", armBGetSize: async () => "265/70R17" });
  expect(agree.sizeAgreement).toBe(true);
  const disagree = await runSizeRace({ armAGetSize: async () => "265/70R17", armBGetSize: async () => "235/75R17" });
  expect(disagree.sizeAgreement).toBe(false);
  const single = await runSizeRace({ armAGetSize: async () => "265/70R17", armBGetSize: async () => "" });
  expect(single.sizeAgreement).toBe(false);
  expect(single.size).toBe("265/70R17"); // still shows the one size for display
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/services/ai/sizeRace.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/sizeRace.ts src/services/ai/sizeRace.test.ts src/app/api/ai-lookup/route.ts
git commit -m "feat(tires): two-independent-source size race (grounded + page fetch) sets sizeAgreement"
```

---

### Task 5: Store auto-count gate honors `internet_two_source_size`

**Files:**
- Modify: `src/stores/scanStore.ts` (the `evidenceGatePassed` in `liveDecode` ~1633 AND in `backgroundVerifyDeep` ~1927; add a shared helper next to `tireAutoCountOk` ~148)
- Test: `src/stores/scanStore.*.test.ts` (use the existing store test that drives a decode result; if none isolates the gate, add `src/stores/scanStore.autocount.test.ts`)

**Interfaces:**
- Consumes: `DecodeDecision.corroborationPath` (now includes `"internet_two_source_size"`).
- Produces: a shared `decodeCorroborated(decision)` predicate so both decode paths agree.

- [ ] **Step 1: Write the failing test**

```ts
// src/stores/scanStore.autocount.test.ts
import { describe, it, expect } from "vitest";
import { decodeCorroborated } from "./scanStore";

describe("decodeCorroborated - what counts as corroboration for auto-count", () => {
  it("true for app-verified exact code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: true } as any)).toBe(true);
  });
  it("true for the internet two-source size path WITHOUT exact-code", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false, corroborationPath: "internet_two_source_size" } as any)).toBe(true);
  });
  it("false for a bare suggested decode with neither", () => {
    expect(decodeCorroborated({ exactCodeEvidenceVerifiedByApp: false } as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/stores/scanStore.autocount.test.ts`
Expected: FAIL - `decodeCorroborated` is not exported.

- [ ] **Step 3: Implement the shared predicate + use it in BOTH gates**

Near `tireAutoCountOk` (~148) in `scanStore.ts`, add and export:

```ts
/**
 * What counts as "corroborated" for auto-count, shared by liveDecode + backgroundVerifyDeep so the rule
 * cannot drift. The app-verified exact code OR the internet_two_source_size path (brand from the strong GS1
 * prefix + two independent Internet sources agreeing on the size). The local DB is never involved.
 */
export function decodeCorroborated(decision: { exactCodeEvidenceVerifiedByApp?: boolean; corroborationPath?: string } | null | undefined): boolean {
  return Boolean(decision?.exactCodeEvidenceVerifiedByApp) || decision?.corroborationPath === "internet_two_source_size";
}
```

In BOTH `evidenceGatePassed` blocks (liveDecode ~1633 and backgroundVerifyDeep ~1927), replace the line
`Boolean(decision?.exactCodeEvidenceVerifiedByApp) &&` with
`decodeCorroborated(decision) &&`.

- [ ] **Step 4: Run the test + the store suite**

Run: `npx vitest run src/stores/scanStore.autocount.test.ts src/stores`
Expected: PASS. (If a broad store test asserts the OLD gate, update it to the new corroboration rule, not the reverse.)

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/stores/scanStore.autocount.test.ts
git commit -m "feat(tires): store auto-count honors internet_two_source_size (shared decodeCorroborated)"
```

---

### Task 6: Instant scan - the fast hot path returns brand-only (no synchronous grounded call)

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts` (the PREFIX-ANCHORED FAST TIRE HOT PATH, lines ~232-290)
- Test: `src/app/api/ai-lookup/*.test.ts` (route handler tests; add `route.hotpath.test.ts` if none cover the hot path)

**Interfaces:**
- Consumes: `lookupTirePrefix(code)` (already imported) for the instant brand anchor.
- Produces: on a tire-prefix hit that is NOT `deepRequested`, the response returns immediately with the prefix brand and `decision.status === "suggested"`, `debug.sizePending === true`, and NO `groundedSpecFind` call. The client then fires `backgroundVerifyDeep` (which runs Task 4's race).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/ai-lookup/route.hotpath.test.ts - drive the POST handler with a tire-prefix code, mode "decode"
// Assert: the response has the prefix brand, decision.status "suggested", debug.sizePending true, and that
// groundedSpecFind was NOT called (spy/mock it to throw if invoked).
```

(Use the repo's existing route-test harness for constructing the request and mocking `groundedSpecFind`; mirror an existing `route.*.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/ai-lookup/route.hotpath.test.ts`
Expected: FAIL - the hot path currently awaits `groundedSpecFind` (so the spy is called) and may return a non-pending shape.

- [ ] **Step 3: Implement - remove the synchronous grounded call**

In the hot path (`if (isTireScan && !deepRequested && !e2eMode()) { ... }`), DELETE the `const { result, evidence } = await groundedSpecFind({ code, codeType, anchorBrand });` line and the synchronous grounded usage. Build the instant response from the prefix anchor only:

```ts
        // INSTANT: brand from the prefix, NO synchronous grounded call. The size fills from the background
        // size race (mode "decode-deep" / backgroundVerifyDeep). Returns immediately.
        const result: AiLookupResult = { ...emptyResult(), brand: anchorBrand ?? "", productName: anchorBrand ?? "", needsHumanReview: true, confidence: 0.6 };
        const evidence: EvidenceResult = { verified: false, strength: "none", matchedCode: code, matchedSources: [], reason: "size pending background fill" };
        const decision = decideDecode({ codeType, results: anchorBrand ? [result] : [], evidences: [evidence], confidenceThreshold: threshold, code, scanContext: "tire" });
```

Add `sizePending: true` to the hot path's `debug` object. Keep `tireHotPath: true`, `aiCalled: false`, `pageFetched: false`.

- [ ] **Step 4: Confirm the client fires the background fill**

The store already calls `void get().backgroundVerifyDeep(reviewId);` (~line 1742) after a suggested decode. Confirm the suggested hot-path response routes through that path (a tire suggestion with `sizePending` must enqueue a review and trigger `backgroundVerifyDeep`). If the trigger is gated on a condition the brand-only response no longer meets, widen it to include `debug.sizePending === true`. Show the exact one-line condition change if needed.

- [ ] **Step 5: Run the route + store tests**

Run: `npx vitest run src/app/api/ai-lookup src/stores`
Expected: PASS.

- [ ] **Step 6: Run the full safety sweep**

Run: `npx vitest run src/services/ai/decode src/services/ai/decodeCorroboration src/services/tire src/eval src/app/api/ai-lookup src/stores scripts/__tests__/mined-prefix-sanity.test.mjs`
Expected: PASS, false-auto-count 0.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/ai-lookup/route.ts src/app/api/ai-lookup/route.hotpath.test.ts
git commit -m "feat(tires): instant tire scan - brand from prefix returns immediately, size fills in background"
```

---

### Task 7: Human Bot Proof Gate (qa:bots)

**Files:**
- No code; run the proof harness and capture screenshots.

- [ ] **Step 1: Discover the exact bot command**

Run: `npm run` and read `package.json` scripts for the `qa:bots*` entries (e.g. `qa:bots`, `qa:bots:scanner`). Use the one covering scanner + auto-count.

- [ ] **Step 2: Run the relevant bot proof**

Run the discovered command (e.g. `npm run qa:bots:scanner`).
Expected: the bot scans a tire, the row shows the brand instantly, the size fills in behind it, a two-source-agreed tire auto-counts, and a single-source size stays in review. Capture the screenshots it writes under `e2e/proof/`.

- [ ] **Step 3: If proof fails, fix and re-run**

Read the failure, fix the cause in the relevant task's files, re-run the bot. Do NOT weaken the proof to go green.

- [ ] **Step 4: Commit the proof artifacts**

```bash
git add e2e/proof
git commit -m "test(tires): qa:bots proof - instant scan + background size fill + two-source auto-count"
```

---

## Self-Review

**Spec coverage:**
- Instant scan, no sync AI -> Task 6. ✓
- Background fill, two independent roads, first valid size, 8s cap -> Task 4 (`runSizeRace`). ✓
- Auto-count only on two-source agreement; single source suggests -> Task 3 (route) + Task 5 (store gate). ✓
- Mine size from description -> Task 1. ✓
- Dead model fix -> Task 2. ✓
- DB never read / no answer-key -> enforced by Global Constraints + no DB import in any task. ✓
- false-auto-count 0 (poison/non-tire/weak-prefix/single-source) -> Task 3 tests + safety sweep each task. ✓
- qa:bots browser proof -> Task 7. ✓
- Size-source seam for the future DB -> `decodeCorroborated` (Task 5) + `runSizeRace` arms are a list-like pair; a `db` arm/source is an additive change. ✓ (no DB code now)

**Placeholder scan:** Task 4 Step 5 and Task 6 Step 4 reference reading the surrounding route/store code for the exact integration point rather than pasting the full 60-line region; the NEW code to add is given verbatim. Task 6 Step 1 names the assertions rather than a full harness because the route-test harness is repo-specific - the implementer mirrors an existing `route.*.test.ts`. These are integration seams, not logic placeholders.

**Type consistency:** `sizeAgreement?: boolean` (AiLookupResult) is set in Task 4, read in Task 3. `corroborationPath: "internet_two_source_size"` is produced in Task 3, consumed in Task 5 (`decodeCorroborated`). `agreeOnSize` / `runSizeRace` signatures match between Task 4 definition and use. Consistent.
