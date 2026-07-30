# GPT-5.5 Ladder End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the live decode ladder (`computeDecode` in `/api/ai-lookup`) ends a scan with neither a verified nor a suggested identity, GPT-5.5 searches the web FROM SCRATCH (code only, no handoff evidence) and its self-reported answer is applied through owner-approved trust tiers, with a persistent decode cache and hard dollar guards.

**Architecture:** A pure DI service (`gptFromScratch.ts`) makes one Responses-API call with the proven 21/21 config; a new final rung in `computeDecode` invokes it behind kill-switch/cap/dollar guards; a Turso-backed (file-fallback) persistent cache stops production re-spend; the scan store applies three trust tiers and queues decodes with bounded concurrency; Settings shows a spend panel.

**Tech Stack:** Next.js 16 App Router route handlers, TypeScript, Zustand scan store, Vitest (node project for services), Playwright, libsql/Turso (existing client in `src/server/retail-knowledge/`), OpenAI Responses API.

## Global Constraints

- Owner trust rule: NO app-side re-verification of GPT's answer. Tiers from GPT's OWN report: `exactCodeFound === true && confidence >= 0.8` -> verified/auto-count; `confidence >= 0.5` (below the verified bar) -> suggested (one-tap); `confidence < 0.5` -> background info on the review item only, NEVER a tappable candidate.
- Two deterministic house rules still precede auto-count: the prefix firewall result already computed by the route (`fw0.conflict`), and code-type (X00/FNSKU/`vendor_label` codes never reach the GPT rung at all).
- Exact model config (verbatim, the 21/21 setup + owner's new caps): model `"gpt-5.5"`, endpoint `https://api.openai.com/v1/responses`, `tools: [{ type: "web_search", search_context_size: "low" }]`, `reasoning: { effort: "low" }`, `max_output_tokens: 6000`, `max_tool_calls: 6`, abort at `10_000` ms.
- Prompt v2 verbatim (from `scripts/tmp-pro-probe2.mjs`):
  `Identify the product for barcode ${code}. Search the web. Return JSON only: {"brand":"","productName":"","specs":"","gtin":"","confidence":0.0,"exactCodeFound":false,"basis":"","sourceUrls":[]}. If you find this exact code in a real page, set exactCodeFound true and confidence to match the evidence. If you cannot, STILL return your single best guess from partial matches, barcode prefix ownership, or similar listings - set exactCodeFound false, confidence 0.4 or less, and say why in basis. Keep it brief. Never leave productName empty if you have any plausible guess.`
- Cost truth: worst case per call $0.39 (30K in x $5/M + 6K out x $30/M + 6 x $0.01 searches). Dollar guard counts ACTUALS from `data.usage.input_tokens/output_tokens` + $0.01 per `web_search_call` output item, with per-call precheck `spentToday + 0.39 <= capUsd`. An aborted call is recorded at the full $0.39 worst case (it still bills server-side).
- Keys server-side only. All automated tests mock fetch / the route (`IS_E2E=1` forces mock providers). NO live OpenAI calls in any automated test.
- Count-first is untouched: scans count instantly; the GPT rung only affects product identity.
- No React/next imports in `src/services`. Follow existing file patterns; keep services pure with DI.
- Commit after every task with a descriptive message.

---

### Task 1: `gptFromScratch` pure service (call + parse + tiers)

**Files:**
- Create: `src/services/ai/gptFromScratch.ts`
- Test: `src/services/ai/gptFromScratch.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. `fetch` injected.
- Produces (later tasks rely on these exact names):
  ```ts
  export type GptTier = "verified" | "suggested" | "info_only" | "none";
  export interface GptFromScratchResult {
    tier: GptTier;
    brand: string;
    productName: string;
    specs: string;
    gtin: string;
    confidence: number;        // clamped 0..1
    exactCodeFound: boolean;
    basis: string;
    sourceUrls: string[];
    searches: number;          // count of web_search_call items
    usdActual: number;         // tokens at $5/$30 per 1M + searches x $0.01
    usdWorstCase: 0.39;
    aborted: boolean;
    error?: string;            // network/HTTP/JSON failure, contained
    raw?: unknown;             // parsed model JSON for logging
  }
  export function gptTierFor(exactCodeFound: boolean, confidence: number): GptTier;
  export async function gptFromScratch(
    code: string,
    deps: { apiKey: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number },
  ): Promise<GptFromScratchResult>;
  ```

- [ ] **Step 1: Write the failing tests** (`src/services/ai/gptFromScratch.test.ts`):

```ts
import { describe, expect, test, vi } from "vitest";
import { gptFromScratch, gptTierFor } from "./gptFromScratch";

const MODEL_JSON = {
  brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17", specs: "265/70R17 115T",
  gtin: "848983006257", confidence: 0.92, exactCodeFound: true,
  basis: "exact code on tirerack product page", sourceUrls: ["https://www.tirerack.com/x"],
};
const respBody = (json: unknown, searches = 2, inTok = 3000, outTok = 900) => ({
  output: [
    ...Array.from({ length: searches }, () => ({ type: "web_search_call" })),
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(json) }] },
  ],
  usage: { input_tokens: inTok, output_tokens: outTok },
});
const okFetch = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe("gptTierFor", () => {
  test("trust tiers follow the owner gate exactly", () => {
    expect(gptTierFor(true, 0.8)).toBe("verified");
    expect(gptTierFor(true, 0.92)).toBe("verified");
    expect(gptTierFor(false, 0.92)).toBe("suggested");   // no exactCodeFound -> never verified
    expect(gptTierFor(true, 0.79)).toBe("suggested");
    expect(gptTierFor(false, 0.5)).toBe("suggested");
    expect(gptTierFor(false, 0.49)).toBe("info_only");
    expect(gptTierFor(true, 0.3)).toBe("info_only");
  });
});

describe("gptFromScratch", () => {
  test("sends the exact 21/21 config and parses a strong answer to verified", async () => {
    const f = okFetch(respBody(MODEL_JSON));
    const r = await gptFromScratch("848983006257", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("verified");
    expect(r.productName).toContain("Wildpeak");
    expect(r.searches).toBe(2);
    expect(r.usdActual).toBeCloseTo((3000 / 1e6) * 5 + (900 / 1e6) * 30 + 0.02, 5);
    const body = JSON.parse((f as any).mock.calls[0][1].body);
    expect(body.model).toBe("gpt-5.5");
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_output_tokens).toBe(6000);
    expect(body.max_tool_calls).toBe(6);
    expect(body.input).toContain("848983006257");
    expect(body.input).toContain("exactCodeFound");
  });

  test("weak best-guess maps to info_only and keeps the guess text", async () => {
    const f = okFetch(respBody({ ...MODEL_JSON, confidence: 0.3, exactCodeFound: false }));
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("info_only");
    expect(r.productName).toContain("Wildpeak");
  });

  test("malformed JSON is contained: tier none + error, never a throw", async () => {
    const f = okFetch({ output: [{ type: "message", content: [{ type: "output_text", text: "not json {" }] }], usage: { input_tokens: 10, output_tokens: 5 } });
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("none");
    expect(r.error).toBeTruthy();
  });

  test("HTTP error is contained with status in error", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "rate" } }) })) as unknown as typeof fetch;
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.tier).toBe("none");
    expect(r.error).toContain("429");
    expect(r.usdWorstCase).toBe(0.39);
  });

  test("10s abort: fetch rejecting with AbortError -> aborted true, usdActual = worst case", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      return await new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }) as unknown as typeof fetch;
    const p = gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f, timeoutMs: 20 });
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.usdActual).toBe(0.39); // billed server-side anyway: count worst case
    expect(r.tier).toBe("none");
  });

  test("confidence is clamped and junk fields tolerated", async () => {
    const f = okFetch(respBody({ brand: 7, productName: "X", confidence: 4, exactCodeFound: "yes", sourceUrls: "nope" }));
    const r = await gptFromScratch("049000000000", { apiKey: "k", fetchImpl: f });
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(r.sourceUrls)).toBe(true);
    expect(typeof r.brand).toBe("string");
  });
});
```

- [ ] **Step 2: Run to verify RED:** `npx vitest run src/services/ai/gptFromScratch.test.ts` -> FAIL (module not found).
- [ ] **Step 3: Implement** `src/services/ai/gptFromScratch.ts`:

```ts
// GPT-5.5 "search from scratch" - the paid END of the decode ladder (owner spec 2026-07-05).
// Input is the CODE ONLY (no handoff evidence). The answer is TRUSTED per the owner's rule;
// tiers come from GPT's OWN self-report. This module is pure: fetch injected, no env reads.
const IN_USD_PER_M = 5.0;
const OUT_USD_PER_M = 30.0;
const USD_PER_SEARCH = 0.01;
export const GPT_LADDER_WORST_CASE_USD = 0.39 as const;

export type GptTier = "verified" | "suggested" | "info_only" | "none";

export interface GptFromScratchResult {
  tier: GptTier;
  brand: string;
  productName: string;
  specs: string;
  gtin: string;
  confidence: number;
  exactCodeFound: boolean;
  basis: string;
  sourceUrls: string[];
  searches: number;
  usdActual: number;
  usdWorstCase: typeof GPT_LADDER_WORST_CASE_USD;
  aborted: boolean;
  error?: string;
  raw?: unknown;
}

export function gptTierFor(exactCodeFound: boolean, confidence: number): GptTier {
  if (exactCodeFound && confidence >= 0.8) return "verified";
  if (confidence >= 0.5) return "suggested";
  return "info_only";
}

const promptFor = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. Return JSON only: {"brand":"","productName":"","specs":"","gtin":"","confidence":0.0,"exactCodeFound":false,"basis":"","sourceUrls":[]}. If you find this exact code in a real page, set exactCodeFound true and confidence to match the evidence. If you cannot, STILL return your single best guess from partial matches, barcode prefix ownership, or similar listings - set exactCodeFound false, confidence 0.4 or less, and say why in basis. Keep it brief. Never leave productName empty if you have any plausible guess.`;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clamp01 = (n: unknown) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };

function none(partial: Partial<GptFromScratchResult>): GptFromScratchResult {
  return {
    tier: "none", brand: "", productName: "", specs: "", gtin: "", confidence: 0,
    exactCodeFound: false, basis: "", sourceUrls: [], searches: 0,
    usdActual: 0, usdWorstCase: GPT_LADDER_WORST_CASE_USD, aborted: false, ...partial,
  };
}

export async function gptFromScratch(
  code: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number },
): Promise<GptFromScratchResult> {
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let data: {
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  try {
    const res = await f("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: promptFor(code),
        tools: [{ type: "web_search", search_context_size: "low" }],
        reasoning: { effort: "low" },
        max_output_tokens: 6000,
        max_tool_calls: 6,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return none({ error: `HTTP ${res.status}`, usdActual: GPT_LADDER_WORST_CASE_USD });
    data = await res.json();
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    // A client-aborted or failed call may still have executed server-side: count worst case.
    return none({ aborted, usdActual: GPT_LADDER_WORST_CASE_USD, error: aborted ? "aborted at cap" : String(e).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }

  const searches = (data.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const usdActual =
    ((data.usage?.input_tokens ?? 0) / 1e6) * IN_USD_PER_M +
    ((data.usage?.output_tokens ?? 0) / 1e6) * OUT_USD_PER_M +
    searches * USD_PER_SEARCH;

  const text = (data.output ?? [])
    .flatMap((o) => o?.content ?? [])
    .filter((c) => c?.type === "output_text")
    .map((c) => c?.text ?? "")
    .join("");
  let parsed: Record<string, unknown>;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    return none({ searches, usdActual, error: "model returned non-JSON" });
  }

  const exactCodeFound = parsed.exactCodeFound === true;
  const confidence = clamp01(parsed.confidence);
  const productName = str(parsed.productName).trim();
  if (!productName) return none({ searches, usdActual, error: "empty productName", raw: parsed });

  return {
    tier: gptTierFor(exactCodeFound, confidence),
    brand: str(parsed.brand).trim(),
    productName,
    specs: str(parsed.specs).trim(),
    gtin: str(parsed.gtin).replace(/\D/g, ""),
    confidence,
    exactCodeFound,
    basis: str(parsed.basis).slice(0, 300),
    sourceUrls: Array.isArray(parsed.sourceUrls) ? parsed.sourceUrls.filter((u): u is string => typeof u === "string").slice(0, 5) : [],
    searches,
    usdActual,
    usdWorstCase: GPT_LADDER_WORST_CASE_USD,
    aborted: false,
    raw: parsed,
  };
}
```

- [ ] **Step 4: GREEN:** `npx vitest run src/services/ai/gptFromScratch.test.ts` -> all pass. Also `npx tsc --noEmit`.
- [ ] **Step 5: Commit:** `git add src/services/ai/gptFromScratch.ts src/services/ai/gptFromScratch.test.ts && git commit -m "feat(ladder): gptFromScratch service - 21/21 config, trust tiers, contained failures, actuals cost accounting"`

---

### Task 2: Dollar guard for the GPT rung (`aiSpendGuard` extension)

**Files:**
- Modify: `src/services/security/aiSpendGuard.ts` (follow the existing `checkAndIncrementDaily` pattern at L69: in-memory map + best-effort JSON file, same caveats comment)
- Test: `src/services/security/aiSpendGuard.gptLadder.test.ts` (new file; do NOT touch existing tests)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export function checkGptLadderBudget(opts?: { capUsd?: number; file?: string; dateKey?: string; worstCaseUsd?: number }): { allowed: boolean; spentUsd: number; capUsd: number };
  export function recordGptLadderSpend(usd: number, opts?: { file?: string; dateKey?: string }): void;
  ```
  Default `capUsd` from `Number(process.env.GPT_LADDER_DAILY_USD ?? 3)`. `checkGptLadderBudget` allows only when `spentUsd + (opts.worstCaseUsd ?? 0.39) <= capUsd`. Persistence: same JSON file pattern as the daily counter (key `gptLadderUsd:<dateKey>`), same best-effort semantics.

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, test } from "vitest";
import { checkGptLadderBudget, recordGptLadderSpend } from "./aiSpendGuard";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "gptguard-")), "usage.json");

describe("GPT ladder dollar guard", () => {
  test("allows while spent + worst case fits, then blocks", () => {
    const file = tmpFile();
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" }).allowed).toBe(true);
    recordGptLadderSpend(0.5, { file, dateKey: "d1" });
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" }).allowed).toBe(true);   // 0.5 + 0.39 <= 1.0
    recordGptLadderSpend(0.2, { file, dateKey: "d1" });
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" });
    expect(r.allowed).toBe(false);                                                            // 0.7 + 0.39 > 1.0
    expect(r.spentUsd).toBeCloseTo(0.7, 5);
  });
  test("a new day resets", () => {
    const file = tmpFile();
    recordGptLadderSpend(5, { file, dateKey: "d1" });
    expect(checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d2" }).allowed).toBe(true);
  });
  test("survives process restart via the file (new in-memory state, same file)", () => {
    const file = tmpFile();
    recordGptLadderSpend(0.9, { file, dateKey: "d1" });
    // simulate cold start by calling with the same file (module map may or may not hit; file is source)
    const r = checkGptLadderBudget({ capUsd: 1.0, file, dateKey: "d1" });
    expect(r.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: RED.** Run: `npx vitest run src/services/security/aiSpendGuard.gptLadder.test.ts`
- [ ] **Step 3: Implement** in `aiSpendGuard.ts`, following the file's existing read/write helpers for the JSON counter file (read them before writing; reuse the same load/save functions if exported/internal - extend, do not fork the persistence logic). Store cents-precision floats under `gptLadderUsd:<dateKey>`.
- [ ] **Step 4: GREEN** + `npx vitest run src/services/security` (whole dir stays green) + `npx tsc --noEmit`.
- [ ] **Step 5: Commit:** `git commit -m "feat(ladder): daily dollar guard for the GPT rung (actuals + worst-case precheck, file-backed)"`

---

### Task 3: The ladder rung in `computeDecode` (+ IS_E2E mock)

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts` - insert the rung at the END of `computeDecode` (after deep Stage 2, before the final return), plus GET additions in Task 6.
- Test: `src/app/api/ai-lookup/gptLadderRung.test.ts` if route-level tests exist in that folder pattern; otherwise create `src/services/ai/gptLadderRung.test.ts` testing an extracted helper (preferred - see below).

**Interfaces:**
- Consumes: `gptFromScratch`, `gptTierFor` (Task 1); `checkGptLadderBudget`, `recordGptLadderSpend` (Task 2).
- Produces: extracted pure helper so the rung is testable without Next:
  ```ts
  // src/services/ai/gptLadderRung.ts
  export interface GptRungInput {
    code: string;
    codeType: string;                       // from the route's detectCodeType result
    priorStatus: string | undefined;        // decision?.status of the ladder so far
    e2e: boolean;
    apiKeyPresent: boolean;
    budget: { allowed: boolean; spentUsd: number; capUsd: number };
  }
  export function shouldRunGptRung(i: GptRungInput): { run: boolean; skipReason: string };
  export function gptResultToDecodePayload(r: GptFromScratchResult, code: string): {
    result: AiLookupResult; decision: DecodeDecision; reasonText: string;
  } | null; // null when tier === "none"
  ```
- Behavior:
  - `shouldRunGptRung` returns false with an explicit reason when: prior status is `"verified"` or `"suggested"`; `codeType === "vendor_label"` or the code shape is X00/FNSKU (reuse the route's existing codeType value - vendor labels never reach GPT); `e2e` true (mock path instead); no API key; budget not allowed.
  - Mapping to the existing payload shape (recon: route returns `{ results, decision, reasonText... }` and the client reads `decision.status` + `results[0]`):
    - tier `verified` -> `decision = { status: "verified", confidence: r.confidence, reason: "gpt-5.5 from-scratch: exact code self-reported (owner trust rule)", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { agreement: "single_provider" } as CrossCheckResult, corroborationPath: "gpt_self_report" }` - ADD `"gpt_self_report"` to the `CorroborationPath` union in `src/types.ts` L485.
    - tier `suggested` -> same but `status: "suggested"`.
    - tier `info_only` -> `status: "needs_review"`, and the produced `AiLookupResult` sets `needsHumanReview: true`, `confidence` as reported; `reasonText` prefixed `"background info only: "` so the client can route it (Task 5).
    - `AiLookupResult` fields: `productName`, `brand`, `specsShort: r.specs`, `gtin/upc/ean` from `r.gtin` when 12-14 digits, `sourceUrls`, `confidence`, `verifiedFacts: []`, `guesses: r.basis ? [r.basis] : []`, `needsHumanReview: tier !== "verified"`.
  - In the route: call the helper; when `run`, `checkGptLadderBudget` -> `gptFromScratch(code, { apiKey: process.env.OPENAI_API_KEY! })` -> `recordGptLadderSpend(r.usdActual)` ALWAYS (even on error/abort, r.usdActual carries worst case) -> if payload non-null, REPLACE the empty decision with the GPT one, append provider name `"gpt-5.5-ladder"` to `providerNames`, set `reasonCode: "gpt_ladder"`. Prefix-firewall: the route already computed `fw0.conflict` - when true, cap the tier at suggested (never verified), reason suffix `" | prefix-firewall conflict: auto-count blocked"`.
  - IS_E2E mock: when `e2eMode()`, the rung is skipped entirely UNLESS the request body has `mockGptLadder` (test hook): then return a canned payload built from `gptResultToDecodePayload` with a fixture result - this gives Playwright a deterministic path with zero network.
- [ ] **Step 1: Failing tests** for `shouldRunGptRung` (each skip reason) + `gptResultToDecodePayload` (all four tiers incl. null for none; firewall capping is route logic - test the helper's pure parts, and add one test that the exported `capTierForFirewall(payload, conflict)` helper downgrades verified->suggested).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement helper file + wire into `computeDecode` end (read route L560-700 first; insert after the deep escalation block, before `withDecodeCache` result assembly returns).**
- [ ] **Step 4: GREEN:** helper tests + `npx vitest run` (full suite) + `npx tsc --noEmit`.
- [ ] **Step 5: Commit:** `git commit -m "feat(ladder): GPT-5.5 from-scratch rung ends computeDecode behind budget/firewall/e2e gates"`

---

### Task 4: Persistent decode cache + receipts (Turso with file fallback)

**Files:**
- Create: `src/server/decodeCacheStore.ts`
- Modify: `src/app/api/ai-lookup/route.ts` decode-cache peek/write points (recon: `getDecodeCache(code)` L335 and `withDecodeCache` L698 - read `src/services/ai/decodeCache.ts` first and extend AROUND it, keeping the in-memory layer as L1)
- Test: `src/server/decodeCacheStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PersistedDecode { code: string; kind: "result" | "no_result_receipt"; payload: string; tier: string; createdAt: number; }
  export function getPersistedDecode(code: string): Promise<PersistedDecode | null>;
  export function persistDecode(entry: PersistedDecode): Promise<void>;   // upsert by code
  ```
- Backing: libsql/Turso when `TURSO_DATABASE_URL` + auth token present (same client pattern as `src/server/retail-knowledge/retailKnowledgeIndex.ts` - read it and reuse its client construction); otherwise a JSON file `.decode-cache.json` next to `.ai-lookup-usage.json` (same best-effort semantics). Table: `CREATE TABLE IF NOT EXISTS decode_cache (code TEXT PRIMARY KEY, kind TEXT, payload TEXT, tier TEXT, created_at INTEGER)`.
- Semantics: `result` entries are the verified/suggested decode payload (JSON string of the route's cached decode value). `no_result_receipt` entries are PERMANENT (owner rule - no auto-retry; only a request with `forceRetry: true` in the POST body bypasses and overwrites). L1 in-memory decodeCache stays; L2 persistent is consulted on L1 miss BEFORE `checkAndIncrementDaily` (preserving the recon fact that cache hits never burn a daily slot); every fresh decode outcome writes through to L2 (verified/suggested -> `result`; a GPT rung that ended `none`/`info_only` after ALL rungs were empty -> `no_result_receipt` with the reason).
- Tests: file-fallback mode only (no Turso in CI): result roundtrip; receipt blocks a re-decode (route helper `peekPersisted` returns receipt); forceRetry bypass overwrites; corrupted file tolerated (returns null, no throw). Use temp dirs.
- [ ] Steps: failing tests -> RED -> implement -> GREEN (`npx vitest run src/server` + full suite + tsc) -> commit `git commit -m "feat(ladder): persistent decode cache + permanent no-result receipts (Turso, file fallback) - production stops re-spending on repeats"`.

---

### Task 5: Scan store - tier application + decode queue

**Files:**
- Modify: `src/stores/scanStore.ts` (read L1692-2000 `liveDecode` first)
- Test: `src/stores/scanStore.gptLadder.test.ts` (jsdom project; follow existing scanStore test files' setup pattern)

**Interfaces:**
- Consumes: route payload with `decision.corroborationPath === "gpt_self_report"` and `reasonText` possibly prefixed `"background info only: "`.
- Produces (store behavior):
  1. **Verified tier**: the existing evidence gate (L1947 `evidenceGatePassed`) currently requires `decodeCorroborated(decision)` + app-verified evidence, which would block GPT. Extend with an explicit owner-rule branch:
     ```ts
     const gptTrusted =
       decision?.corroborationPath === "gpt_self_report" &&
       decision?.status === "verified" &&
       (decision?.confidence ?? 0) >= 0.8 &&
       isUsableProductName(best?.productName ?? "") &&
       tireOk && !contextConflict;
     const evidenceGatePassed = gptTrusted || (/* existing conjunction unchanged */);
     ```
     `tireOk`/`contextConflict` reuse the existing helpers (they are data-completeness and context rules, kept per spec).
  2. **Suggested tier**: flows through the existing suggested path unchanged (fields land on the review row, one-tap approve).
  3. **info_only**: when `reasonText` starts with `"background info only: "`, the review row stores the guess in `decodeNote` (owner-only) and `hasSuggestion` stays FALSE - it must NOT render as a tappable candidate. Feed badge -> `needs_review`.
  4. **Queue**: new module-level FIFO inside scanStore (`pendingDecodeIds: string[]`, `activeDecodes: number`, `MAX_CONCURRENT_DECODES = 2`). `liveDecode` enqueues and a `drainDecodeQueue` runs entries with bounded concurrency; counting/persistence NEVER waits on the queue. Rapid 20-scan burst = 20 queued, max 2 in flight.
- Tests (mock `fetch` for `/api/ai-lookup`):
  - gpt verified payload -> auto-count happens once (product created, count incremented, alias write via resolveUnknown path), idempotent on repeat application.
  - gpt verified but confidence 0.79 in decision -> no auto-count (suggested path).
  - info_only payload -> `hasSuggestion === false`, `decodeNote` contains the guess, no candidate fields set.
  - queue: fire 6 liveDecodes with a fetch mock that resolves under manual control -> at most 2 fetches in flight at any moment; all 6 complete; order preserved FIFO.
- [ ] Steps: failing tests -> RED -> implement -> GREEN (this store file's whole test set + full suite + tsc) -> commit `git commit -m "feat(ladder): trust-tier application in scanStore + bounded decode queue (burst-safe)"`.

---

### Task 6: Spend panel (Settings) + GET status extension

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts` GET (L191): add `gptLadder: { spentTodayUsd, capUsd, callsToday, enabled }` from the Task 2 guard + a call counter.
- Modify: the Settings page/component that renders AI status (find via `grep -rn "emergencyStop\|aiStatus" src/app src/components` - follow its existing card/row pattern).
- Test: component test (jsdom) with mocked GET payload + one Playwright screenshot step in the existing settings spec if present (else `e2e/gpt-ladder-panel.spec.ts` with `page.route` mocking GET).
- Content: "GPT ladder today: $X.XX of $Y.YY - N calls - Enabled/Blocked (reason)". Copy rule: no em dashes, plain punctuation.
- [ ] Steps: failing test -> RED -> implement -> GREEN + tsc -> commit `git commit -m "feat(ladder): GPT spend panel in Settings + GET status fields"`.

---

### Task 7 (controller-run, no subagent): live proof + stress + report

- [ ] Playwright burst stress: with IS_E2E mock + `mockGptLadder` hook, scan 20 unknown codes rapidly; assert all 20 counted instantly, decode badges settle, max-2-concurrency observed via route-hit log; screenshot to `e2e/proof/`.
- [ ] Live campaign script `scripts/gpt-ladder-live-proof.mts` (pattern: fetchv2-benchmark.mts): canaries FIRST (all 10), then the 53 residue codes from `scripts/fetchv2-ladder-handoff.json`; direct service calls (not through Next) with the real key; HARD stop when `spent + 0.39 > 7.00`; crash-safe incremental writes to `scripts/gpt-ladder-live-results.json`; grade vs `truth` where present.
- [ ] Gates: canaries -> ZERO verified-tier and ZERO suggested-tier (info_only/none acceptable); residue -> report decode rate + wrongs (manual truth check on every verified); spend ledger printed ("computed floor $X; true spend = OpenAI console").
- [ ] Rebuild release-style report page and append results to the ledger.
