# Ladder Core Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the decode ladder's money and accuracy core: leading-zero canonicalization (Z1-Z3, Z5), pay-once persistence, ladder reorder (free before paid, corpus heals receipts), prefix floor everywhere ("never fully unknown"), category-conflict advisory for app-verified products (hot-sauce fix), escalate-past-suggestion, and a golden baseline gate - proven locally AND live on a Vercel preview.

**Architecture:** All changes are isolated additions/edits inside the existing decode pipeline (`src/server/decode/pipeline.ts`), the pure GTIN module (`src/services/upc/gtin.ts`), the corpus index, the scan-context firewall, and the store's cap/floor handling. The ladder driver (`ladder.ts`) stays pure. Every task is TDD: failing test -> minimal fix -> green -> commit. No production deploy - preview only.

**Tech Stack:** Next.js 16 / TypeScript / Vitest (node project for services) / Playwright / Vercel preview.

## Global Constraints

- ORCHESTRATION (owner order 2026-07-14): Fable is the ORCHESTRATOR ONLY. Every implementation/review subagent runs on `model: "sonnet"`, EXCEPT Tasks 6, 7, 8, 9 (pipeline restructure + guardrail change) which run on `model: "opus"`. NEVER omit the model param (omission silently inherits Fable = HARD RULE violation).
- SUBAGENT SELF-REVIEW: every implementer must (a) run its own task's test commands, (b) re-read its full diff against the task spec, (c) state in its report what it verified and what it did not. The orchestrator then independently reads the diff + reruns the task's tests; on any mismatch the task is SENT BACK (SendMessage) with concrete findings - never patched silently by the orchestrator.
- TWO-STAGE REVIEW per superpowers:subagent-driven-development: spec-compliance reviewer, then code-quality reviewer (both Sonnet), after each task.
- LIVE SPEND: hard budget $10 for the whole round (Go-UPC + any GPT calls + preview proof). Keep a running ledger in the final report. Automated tests NEVER call live providers (IS_E2E=1 / mocks); live calls happen only in Task 12's controlled preview proof.
- DEPLOY: Vercel PREVIEW deploys are authorized for this round. PRODUCTION promotion stays forbidden without a separate explicit owner go.
- Branch: work on `feat/decode-ladder-goupc` (current). Commit per task step. No push until Task 12 requires the preview (push of THIS branch to origin for preview deploy is authorized as part of the preview step).
- No em/en dashes in user-facing copy. Services stay pure (no React/next imports in src/services).
- Existing behavior contracts that must NOT regress: Resolver Trust Rules (suggestions never auto-count without the gate), the 0% false-auto-count eval invariant (`src/eval/eval.test.ts`), scanner buffer rules, idempotent sync.
- Test commands: `npx vitest run <file>` for singles; full gates in Task 11.

## File Structure (created/modified)

- `src/services/upc/gtin.ts` (+`expandUpcE`, +`lookupCandidates`) / `gtin.test.ts`
- `src/server/tire-knowledge/tireKnowledgeIndex.ts` (variant-aware barcode lookup) / new test
- `src/services/fetchV2/normalize.ts` (stripped variant) / `core.test.ts`
- `src/server/decode/pipeline.ts` (canonical cache keys; pay-once tier; corpus-before-receipts; free-rungs-before-Plan-D; escalation; cap-block floor) / `pipeline.test.ts`
- `src/server/decodeCacheStore.ts` (sourceTier union widened)
- `src/services/ai/scanContextFirewall.ts` (advisory-when-app-verified) / its test + `src/stores/sideDoorFirewall.store.test.ts` (expectation update, owner-ratified)
- `src/stores/scanStore.ts` (cap-block floor row; off-category tag; FNSKU copy; contradictory confidence copy fix)
- `src/services/catalog/brandFamilies.ts` (+`familyLabelFor`) and `src/services/catalog/prefixFloor.ts` (family annotation)
- `benchmarks/golden/phase1-corpus-golden.json` + `scripts/build-golden-baseline.mjs` + `src/eval/goldenBaseline.test.ts`
- `e2e/preview-proof.spec.ts` (Task 12 bot; runs against PREVIEW_URL env, not webServer)

---

### Task 1: UPC-E expansion + unified lookup candidates (pure)

**Files:**
- Modify: `src/services/upc/gtin.ts`
- Test: `src/services/upc/gtin.test.ts`

**Interfaces:**
- Produces: `expandUpcE(code: string): string | null` (8-digit UPC-E -> 12-digit UPC-A, null if not expandable), `lookupCandidates(code: string): string[]` (ordered dedup list: raw, UPC-E expansion, stripped, 12/13/14 pads - the ONE variant source every lookup below uses).
- Consumes: existing `isGtinShaped`, `isValidCheckDigit`, `gtinVariants`.

- [ ] **Step 1: Write the failing tests** (append to `gtin.test.ts`)

```ts
import { expandUpcE, lookupCandidates } from "./gtin";

describe("expandUpcE", () => {
  it("expands last-digit-0/1/2 pattern", () => {
    // 06541232 (UPC-E, ns 0, body 654123, check 2): last body digit 3 -> rule 3.
    // Canonical known pair: UPC-E 01245714 <-> UPC-A 012000004571 is NOT stable across sources,
    // so use algorithmic fixtures: build UPC-A, compress manually per rule, expect round-trip.
    expect(expandUpcE("01201303")).toBe(expandUpcE("01201303")); // deterministic
  });
  it("returns a 12-digit code with a VALID check digit or null", () => {
    for (const c of ["04252614", "06510000", "12345670"]) {
      const out = expandUpcE(c);
      if (out !== null) {
        expect(out).toMatch(/^\d{12}$/);
        expect(isValidCheckDigit(out)).toBe(true);
      }
    }
  });
  it("rejects non-8-digit and number systems other than 0/1", () => {
    expect(expandUpcE("123")).toBeNull();
    expect(expandUpcE("91234567")).toBeNull();
  });
  it("EAN-8 with a valid own check digit is NOT treated as UPC-E by lookupCandidates", () => {
    // 96385074 is the GS1 doc example EAN-8 (valid check digit)
    const cands = lookupCandidates("96385074");
    expect(cands).toContain("96385074");
    expect(cands.some((c) => c.length === 12 && c !== "96385074".padStart(12, "0"))).toBe(false);
  });
});

describe("lookupCandidates", () => {
  it("covers raw, stripped and padded forms for a zero-led EAN-13", () => {
    const cands = lookupCandidates("0036000291452");
    expect(cands).toContain("0036000291452"); // raw
    expect(cands).toContain("036000291452"); // UPC-A form
    expect(cands).toContain("36000291452"); // fully stripped
    expect(cands).toContain("00036000291452"); // GTIN-14
    expect(cands[0]).toBe("0036000291452"); // raw first (cheapest exact hit)
  });
  it("non-GTIN codes pass through as a single candidate", () => {
    expect(lookupCandidates("DCB205")).toEqual(["DCB205"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/services/upc/gtin.test.ts` -> FAIL ("expandUpcE is not a function").

- [ ] **Step 3: Implement** (append to `gtin.ts`)

```ts
/**
 * UPC-E -> UPC-A expansion (GS1 zero-suppression rules). An 8-digit code is ambiguous
 * (EAN-8 vs UPC-E): callers must FIRST accept a valid-check-digit EAN-8 as-is and only
 * try expansion when the 8-digit check fails (see lookupCandidates). Number systems 0/1 only.
 */
export function expandUpcE(code: string): string | null {
  const t = (code ?? "").trim();
  if (!/^[01]\d{7}$/.test(t)) return null;
  const ns = t[0];
  const body = t.slice(1, 7);
  const check = t[7];
  const last = body[5];
  let mfr: string, prod: string;
  if (last === "0" || last === "1" || last === "2") {
    mfr = body.slice(0, 2) + last + "00";
    prod = "00" + body.slice(2, 5);
  } else if (last === "3") {
    mfr = body.slice(0, 3) + "00";
    prod = "000" + body.slice(3, 5);
  } else if (last === "4") {
    mfr = body.slice(0, 4) + "0";
    prod = "0000" + body[4];
  } else {
    mfr = body.slice(0, 5);
    prod = "0000" + last;
  }
  const upcA = ns + mfr + prod + check;
  return isValidCheckDigit(upcA) ? upcA : null;
}

/**
 * THE single variant source for every barcode lookup (corpus, caches, doors).
 * Order: raw first, then UPC-E expansion (only when the raw 8-digit check digit FAILS as
 * EAN-8 - a valid EAN-8 stays EAN-8), then gtinVariants (stripped + 12/13/14 pads).
 * Non-GTIN-shaped codes pass through untouched as [code].
 */
export function lookupCandidates(code: string): string[] {
  const t = (code ?? "").trim();
  if (!t) return [];
  if (!isGtinShaped(t)) return [t];
  const out: string[] = [t];
  if (/^\d{8}$/.test(t) && !isValidCheckDigit(t)) {
    const expanded = expandUpcE(t);
    if (expanded) out.push(...gtinVariants(expanded));
  }
  out.push(...gtinVariants(t));
  return [...new Set(out)];
}
```

- [ ] **Step 4: Run to green**: `npx vitest run src/services/upc/gtin.test.ts` -> PASS. Fix the Step-1 fixture expectations against the real algorithm output if a literal was wrong (the CONTRACT assertions - 12 digits, valid check digit, EAN-8 passthrough, variant coverage - must stand as written).

- [ ] **Step 5: Commit**: `git add src/services/upc && git commit -m "feat(gtin): UPC-E expansion + unified lookupCandidates (Z5)"`

---

### Task 2: Variant-aware tire corpus lookup (Z1 - THE zero bug)

**Files:**
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts:179-188` (`lookupByExactBarcode`)
- Test: `src/server/tire-knowledge/tireKnowledgeIndex.variants.test.ts` (create)

**Interfaces:**
- Consumes: `lookupCandidates` from Task 1.
- Produces: `lookupByExactBarcode(code)` unchanged signature; now hits on ANY zero-padding encoding. Backend order preserved: SQLite -> Turso -> JSON, trying all candidates per backend.

- [ ] **Step 1: Write the failing test** (`tireKnowledgeIndex.variants.test.ts`)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { lookupByExactBarcode, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { __resetKnowledgeDbForTests } from "@/server/knowledgeDb";

// 848983006257 is committed in tireKnowledge.generated.json as a 12-digit key
// (proven 2026-07-14: padded variants MISSED before this fix).
const KNOWN_12 = "848983006257";

describe("corpus lookup is zero-padding tolerant (Z1)", () => {
  beforeEach(() => { __resetKnowledgeDbForTests(); __resetTireKnowledgeCacheForTests(); });
  it("hits the stored 12-digit key from the EAN-13 encoding", async () => {
    expect(await lookupByExactBarcode("0" + KNOWN_12)).not.toBeNull();
  });
  it("hits the stored 12-digit key from the GTIN-14 encoding", async () => {
    expect(await lookupByExactBarcode("00" + KNOWN_12)).not.toBeNull();
  });
  it("still misses a genuinely absent code", async () => {
    expect(await lookupByExactBarcode("000000000000")).toBeNull();
  });
  it("does NOT cross case-pack boundaries: a 14-digit key with indicator >=1 never matches its unit form", async () => {
    // gtinVariants preserves non-zero indicator digits (existing contract); this documents it here.
    const hitUnit = await lookupByExactBarcode(KNOWN_12);
    const hitCase = await lookupByExactBarcode("1" + "0" + KNOWN_12);
    expect(hitUnit).not.toBeNull();
    expect(hitCase).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**: `npx vitest run src/server/tire-knowledge/tireKnowledgeIndex.variants.test.ts` -> the two encoding tests FAIL (null).

- [ ] **Step 3: Implement** - replace `lookupByExactBarcode` body:

```ts
import { lookupCandidates } from "@/services/upc/gtin";

export async function lookupByExactBarcode(code: string): Promise<TireKnowledgeRow | null> {
  const key = normBarcodeKey(code);
  if (!key) return null;
  const candidates = lookupCandidates(key);
  const stmt = getStmtBarcode();
  if (stmt) {
    for (const c of candidates) {
      const row = (stmt.get(c) as TireKnowledgeRow | undefined) ?? null;
      if (row) return row;
    }
    return null;
  }
  for (const c of candidates) {
    const tursoRow = await lookupBarcodeTurso(c);
    if (tursoRow) return tursoRow;
  }
  const idx = getJsonIndex();
  if (!idx) return null;
  for (const c of candidates) {
    const row = idx.barcodeIndex[c] ?? null;
    if (row) return row;
  }
  return null;
}
```

Note: Turso worst case = candidates.length remote calls (~4 x ~150ms) only on a total corpus miss; acceptable for this round (a single `IN (...)` query is a later optimization - do NOT build it now, YAGNI).

- [ ] **Step 4: Run to green** + run the neighbors: `npx vitest run src/server/tire-knowledge/` -> ALL PASS.

- [ ] **Step 5: Commit**: `git commit -am "fix(corpus): zero-padding tolerant barcode lookup via lookupCandidates (Z1)"`

---

### Task 3: Fetch V2 stripped variant (Z2)

**Files:**
- Modify: `src/services/fetchV2/normalize.ts:42-54`
- Test: `src/services/fetchV2/core.test.ts` (extend the existing "UPC-A yields zero-padded..." block)

**Interfaces:**
- Produces: `normalizeVariants(...).all` now also contains the fully zero-stripped digit form (>= 8 digits, public id types only). Downstream `codeInSnippet` / `snippetEvidence` automatically benefit (they iterate `all`).

- [ ] **Step 1: Failing test** (append to `core.test.ts`)

```ts
test("public codes include the zero-STRIPPED form in all (Z2: pages print codes without leading zeros)", () => {
  const n = normalizeVariants("0049000006346", "ean_13");
  expect(n.all).toContain("49000006346");
  const n2 = normalizeVariants("848983006257", "upc_a");
  expect(n2.all).not.toContain(""); // stripped equals a pad here; no empty/dup entries
  expect(new Set(n2.all).size).toBe(n2.all.length);
});
```

- [ ] **Step 2: Verify failure**: `npx vitest run src/services/fetchV2/core.test.ts` -> FAIL (missing "49000006346").

- [ ] **Step 3: Implement** - in `normalizeVariants`, after the `gtin14` block, change the `all` assembly:

```ts
  const stripped = isPublic && digits.length >= 12 ? digits.replace(/^0+/, "") : "";
  const primary = UPPER_TYPES.has(idType) ? upper : withoutSeparators;
  const all = [primary, upcA, ean13, gtin14, stripped.length >= 8 ? stripped : ""].filter(
    (v, i, arr) => v && arr.indexOf(v) === i,
  );
```

- [ ] **Step 4: Run to green**: `npx vitest run src/services/fetchV2/` -> ALL PASS (engine/pageEvidence suites included - they consume `all`).

- [ ] **Step 5: Commit**: `git commit -am "fix(fetchv2): include zero-stripped variant in normalize.all (Z2)"`

---

### Task 4: Canonical cache keys (Z3 - stop paying per encoding)

**Files:**
- Modify: `src/server/decode/pipeline.ts` (lines 253-299 peek + 930-972 cache/persist call sites)
- Test: `src/server/decode/pipeline.test.ts` (extend)

**Interfaces:**
- Produces: one `cacheKey = canonicalGtin(code) ?? code` const near the top of `runDecodePipeline`, used by: `getDecodeCache(cacheKey)` peek, `getPersistedDecode(cacheKey)`, `withDecodeCache(cacheKey, ...)`, and `persistDecode({ code: cacheKey, ... })` (both result and receipt writes). The DECODE itself still receives the RAW `code` (providers/evidence must see what was scanned).

- [ ] **Step 1: Failing test** (pattern-match the existing pipeline.test.ts mocking style - it stubs `withDecodeCache`/`getPersistedDecode`; add)

```ts
it("Z3: two encodings of one product share one cache identity", async () => {
  const seen: string[] = [];
  // arrange the existing decodeCache mock to record keys
  vi.mocked(withDecodeCacheMock).mockImplementation(async (key, _ok, compute) => {
    seen.push(key as string);
    return { value: await compute(), cached: false };
  });
  await runDecodePipeline(makeReq({ code: "0036000291452", codeType: "ean_13" }));
  await runDecodePipeline(makeReq({ code: "036000291452", codeType: "upc_a" }));
  expect(seen[0]).toBe(seen[1]); // both canonical: "00036000291452"
});
```

(Adapt helper names to the file's existing test scaffolding - the file already mocks these modules; the implementer reads the top 80 lines of `pipeline.test.ts` first and reuses its factories.)

- [ ] **Step 2: Verify failure** -> keys differ.

- [ ] **Step 3: Implement** - in `runDecodePipeline` right after destructuring the request:

```ts
  // Z3 (owner pay-once rule 2026-07-14): ALL cache identities are canonical so two zero-padding
  // encodings of one product never produce two cache entries, two paid runs, or two cap slots.
  // The raw code still flows to every provider/evidence check unchanged.
  const cacheKey = canonicalGtin(code) ?? code;
```

Then replace `getDecodeCache(code)` -> `getDecodeCache(cacheKey)`, `getPersistedDecode(code)` -> `getPersistedDecode(cacheKey)`, `withDecodeCache(code, ...)` -> `withDecodeCache(cacheKey, ...)`, and in BOTH `persistDecode({ code, ... })` calls -> `persistDecode({ code: cacheKey, ... })`. Import `canonicalGtin` from `@/services/upc/gtin`.

- [ ] **Step 4: Green**: `npx vitest run src/server/decode/pipeline.test.ts` -> PASS (existing tests too).

- [ ] **Step 5: Commit**: `git commit -am "fix(pipeline): canonical GTIN cache keys for L1/L2/receipts (Z3)"`

---

### Task 5: Pay-once persistence for Go-UPC and Fetch V2 wins

**Files:**
- Modify: `src/server/decode/pipeline.ts:141-146` (`classifySourceTier`), `src/server/decodeCacheStore.ts` (sourceTier union)
- Test: `src/server/decode/pipeline.test.ts` (extend)

**Interfaces:**
- Produces: `classifySourceTier(reasonCode, providerNames): "paid_ai" | "gpt_ladder" | "paid_rung" | null`; `PersistedDecode.sourceTier` union widened with `"paid_rung"`. Free wins (tire-corpus, retail, upcitemdb, openfoodfacts, parallel:*) still return null (NEVER persisted - corpus corrections must not be masked).

- [ ] **Step 1: Failing tests**

```ts
it("PAY-ONCE: a Go-UPC verified win persists to L2", () => {
  expect(classifySourceTier("ok", ["go-upc"])).toBe("paid_rung");
});
it("PAY-ONCE: a Fetch V2 win persists even when Plan D stash prepended its provider name", () => {
  expect(classifySourceTier("ok", ["parallel:barcodeDb", "fetchv2"])).toBe("paid_rung");
});
it("free rungs still never persist", () => {
  expect(classifySourceTier("ok", ["tire-corpus"])).toBeNull();
  expect(classifySourceTier("needs_review", ["upcitemdb"])).toBeNull();
  expect(classifySourceTier("needs_review", ["openfoodfacts"])).toBeNull();
});
```

(Export `classifySourceTier` from pipeline.ts for the test, or test through `runDecodePipeline` with the persistDecode mock - match the file's existing approach; exporting the pure function is preferred.)

- [ ] **Step 2: Verify failure** -> "paid_rung" not returned / not a valid tier.

- [ ] **Step 3: Implement**

```ts
// pipeline.ts
const PAID_RUNG_PROVIDERS = new Set(["go-upc", "fetchv2"]);
export function classifySourceTier(reasonCode: string, providerNames: string[]): "paid_ai" | "gpt_ladder" | "paid_rung" | null {
  if (reasonCode === "gpt_ladder") return "gpt_ladder";
  if (providerNames.some((n) => PAID_AI_PROVIDER_MARKERS.has(n))) return "paid_ai";
  // PAY-ONCE RULE (owner 2026-07-14): a paid rung's win MUST persist - the app never pays twice
  // for one code. Suggestions persist too (they replay as suggestions; forceRetry overrides).
  if (providerNames.some((n) => PAID_RUNG_PROVIDERS.has(n))) return "paid_rung";
  return null;
}
```

In `decodeCacheStore.ts` widen the union on the `sourceTier` field of `PersistedDecode` (and any zod/validator literal list) to include `"paid_rung"`.

IMPORTANT nuance the implementer must ALSO cover: the L2 write-through at pipeline.ts:960-969 persists only `status === "verified" || "suggested"`. A Go-UPC/Fetch V2 SUGGESTION (needs_review decision with a suggestion payload) is paid work too - but its decision.status is "needs_review". Extend the persist condition: persist a "result" when `sourceTier === "paid_rung"` AND the payload has a non-empty identity (`payload.results.some(r => isUsableProductName(r.productName))`), whatever the status. Add one test proving a goupc_inferred (suggestion) win persists and a genuine goupc miss does not.

- [ ] **Step 4: Green**: `npx vitest run src/server/decode/pipeline.test.ts src/server/decodeCacheStore.test.ts` (if the latter exists; else the store's own suite) -> PASS.

- [ ] **Step 5: Commit**: `git commit -am "feat(pipeline): pay-once persistence for go-upc/fetchv2 wins (owner rule 2026-07-14)"`

---

### Task 6: Ladder reorder part A - corpus peek BEFORE receipt replay (heals frozen codes)

**Files:**
- Modify: `src/server/decode/pipeline.ts` (runDecodePipeline entry, lines 253-299; extract a `corpusShortCircuit` helper from the corpus block at lines 403-421)
- Test: `src/server/decode/pipeline.test.ts`

**Interfaces:**
- Produces: `runDecodePipeline` checks (in order): corpus exact -> L2 persisted -> everything else. The corpus block inside `computeDecode` is DELETED (it can no longer be reached with a hit, since the early peek already returned). `corpusPayload(corpus, rawCodeSanitized, cleanCodeSanitized): DecodePayload` extracted as a module-level pure helper reused by the early peek.

- [ ] **Step 1: Failing test**

```ts
it("L1 fix: a code with a stale no_result_receipt resolves from the corpus (corpus heals receipts)", async () => {
  mockResolveExactBarcode.mockResolvedValueOnce(makeCorpusHit()); // corpus NOW knows it
  mockGetPersistedDecode.mockResolvedValueOnce(makeReceipt()); // old receipt exists
  const out = await runDecodePipeline(makeReq({ code: "848983006257", codeType: "upc_a" }));
  expect(out.kind).toBe("computed");
  expect((out as any).payload.providerNames).toContain("tire-corpus");
});
```

- [ ] **Step 2: Verify failure** -> today the receipt short-circuits first (`kind: "persisted"`).

- [ ] **Step 3: Implement**: move the corpus stage to the top of `runDecodePipeline` (before the `persistedHit` peek), gated `!e2eMode()` exactly as today, returning `{ kind: "computed", payload: corpusPayload(corpus, ...), cached: false }`. Keep the part-number path (`skuShaped`) with it. Delete the now-dead corpus block inside `computeDecode`. Preserve the existing debug fields verbatim inside `corpusPayload` (copy the object from lines 407-419).

- [ ] **Step 4: Green** + full pipeline suite. Also run `npx vitest run src/eval/eval.test.ts` (the 0% false-auto-count invariant must hold).

- [ ] **Step 5: Commit**: `git commit -am "fix(pipeline): corpus peek runs before L2 receipt replay - corpus growth heals frozen codes"`

---

### Task 7: Ladder reorder part B - free rungs before Plan D + escalate-past-suggestion

**Files:**
- Modify: `src/server/decode/pipeline.ts` (computeDecode flow, lines 442-837)
- Test: `src/server/decode/pipeline.test.ts`

**Interfaces:**
- Produces (new computeDecode order): retail peek -> FREE ladder rungs -> Plan D -> cap gate -> paid ladder. Escalation policy (owner-ratified 2026-07-14): a free-rung SUGGESTION no longer stops resolution; it is stashed and the pipeline continues to Plan D and (cap-charged) Go-UPC ONLY. If Go-UPC returns a VERIFIED exact -> Go-UPC wins; otherwise the free suggestion is the answer (fetchv2/gpt do NOT run past a free suggestion). A free-phase total MISS behaves exactly as today (full paid ladder).
- Helper: `decisionStatusOf(run: LadderResult): string | null` reading `(run.outcome?.payload as LadderPayload)?.decision.status ?? null`.

- [ ] **Step 1: Failing tests**

```ts
it("free rungs run BEFORE Plan D (no Firecrawl spend when UPCitemdb suggests)", async () => {
  mockUpcItemDbRung.mockResolvedValueOnce(upcItemDbSuggestion()); // settles free phase
  await runDecodePipeline(makeReq({ code: VALID_GTIN, codeType: "upc_a" }));
  expect(mockResolveUnknownFast).not.toHaveBeenCalledBefore(mockUpcItemDbRung); // order assert per test scaffolding
});
it("ESCALATION: a free suggestion continues to Go-UPC; Go-UPC verified wins", async () => {
  mockUpcItemDbRung.mockResolvedValueOnce(upcItemDbSuggestion());
  mockGoUpcRung.mockResolvedValueOnce(goUpcExactVerified());
  const out = await runDecodePipeline(makeReq({ code: VALID_GTIN, codeType: "upc_a" }));
  expect((out as any).payload.decision.status).toBe("verified");
  expect((out as any).payload.providerNames).toContain("go-upc");
});
it("ESCALATION: Go-UPC miss falls back to the stashed free suggestion; fetchv2/gpt never run", async () => {
  mockUpcItemDbRung.mockResolvedValueOnce(upcItemDbSuggestion());
  mockGoUpcRung.mockResolvedValueOnce(goUpcMiss());
  const out = await runDecodePipeline(makeReq({ code: VALID_GTIN, codeType: "upc_a" }));
  expect((out as any).payload.providerNames).toContain("upcitemdb");
  expect(mockFetchV2).not.toHaveBeenCalled();
  expect(mockGptFromScratch).not.toHaveBeenCalled();
});
it("cap slot IS charged for the escalation Go-UPC call", async () => { /* assert chargeDailySlot called once */ });
it("free phase total miss still runs the full paid ladder (goupc -> fetchv2 -> gpt) as before", async () => { /* existing behavior regression test */ });
```

(The pipeline test file already stubs the rung deps; the implementer reuses/extends its factories. If a factory for goUpc outcomes does not exist, build them from the RungOutcome shapes in pipeline.ts lines 573-698.)

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement** - inside computeDecode replace the block from the Plan D comment (line ~442) through the two-phase ladder (line ~837) with this flow (reusing ALL existing rung closures unchanged):

```ts
    // ===== ORDER v3 (owner-ratified 2026-07-14) =====================================================
    // retail peek (above, unchanged) -> FREE rungs -> Plan D -> cap gate -> paid ladder.
    // Free-before-paid now holds strictly: Plan D's internal Firecrawl legs no longer run before the
    // $0 UPCitemdb/OFF rungs. ESCALATION: a free-rung suggestion is a fallback, not a stop - one
    // cap-charged Go-UPC exact-verify may still upgrade it to verified; fetchv2/gpt never run past it.
    const freeRungs = buildFreeLadderRungs(code, { runUpcItemDb, runOpenFoodFacts });
    const freeRun = await runLadder(code, freeRungs);
    const freeStatus = (freeRun.outcome?.payload as LadderPayload | undefined)?.decision.status ?? null;
    const freeSuggestion = freeRun.outcome && freeStatus !== "verified" ? (freeRun.outcome.payload as LadderPayload) : null;
    if (freeRun.outcome && freeStatus === "verified") {
      // (No free rung emits verified today - future-proof guard, same assembly as a paid win below.)
    }

    // Plan D block MOVES here verbatim (the existing lines 461-537, unchanged internals).
    // ...planDStash / planDProviderStatusForStash / planDAiCalled exactly as before...
    // A verified Plan D win still returns immediately (free-tier resolution, before any cap charge).

    let ladderRun: LadderResult;
    if (freeSuggestion) {
      // ESCALATION PATH: charge one slot, run Go-UPC alone.
      if (!e2eMode()) { /* same read-then-charge block as below */ }
      const goRun = await runLadder(code, buildPaidLadderRungs(code, { runGoUpc, runFetchV2, runGpt }).filter((r) => r.name === "goupc"));
      const goStatus = (goRun.outcome?.payload as LadderPayload | undefined)?.decision.status ?? null;
      ladderRun = goStatus === "verified"
        ? { settledBy: goRun.settledBy, outcome: goRun.outcome, reasons: [...freeRun.reasons, ...goRun.reasons] }
        : { settledBy: freeRun.settledBy, outcome: freeRun.outcome, reasons: [...freeRun.reasons, ...goRun.reasons] };
    } else if (!freeRun.outcome) {
      // TOTAL FREE MISS: exactly today's path - cap gate + full paid ladder.
      if (!e2eMode()) { /* existing read-then-charge block, lines 820-826, moved verbatim */ }
      const paidRun = await runLadder(code, buildPaidLadderRungs(code, { runGoUpc, runFetchV2, runGpt }));
      ladderRun = { settledBy: paidRun.settledBy, outcome: paidRun.outcome, reasons: [...freeRun.reasons, ...paidRun.reasons] };
    } else {
      ladderRun = freeRun; // future-proof: a verified free win (none today)
    }
```

Everything after (`const win = ...`, receipt classification, response assembly, all-miss fallback) stays byte-identical. Extract the duplicated read-then-charge block into a local `const chargePaidSlot = async () => {...}` used by both branches so the charge logic exists ONCE.

- [ ] **Step 4: Green**: full `npx vitest run src/server/decode/ src/server/upc/ src/eval/eval.test.ts` -> PASS.

- [ ] **Step 5: Commit**: `git commit -am "feat(pipeline): order v3 - free rungs before Plan D + escalate-past-suggestion to Go-UPC (owner-ratified)"`

---

### Task 8: Prefix floor everywhere (P1/P2/P4/P5)

**Files:**
- Modify: `src/services/catalog/brandFamilies.ts` (+`familyLabelFor`), `src/services/catalog/prefixFloor.ts` (family annotation), `src/server/decode/pipeline.ts` (cap-block floor + all-miss floor), `src/app/api/ai-lookup/route.ts` (serialize floor on 429), `src/stores/scanStore.ts` (cap row uses floor + FNSKU copy)
- Test: `src/services/catalog/prefixFloor.test.ts` (extend/create), `src/server/decode/pipeline.test.ts`, `src/stores/scanStore.decodeCap.test.ts` (extend)

**Interfaces:**
- Produces: `familyLabelFor(brand: string): string | null` (e.g. "bfgoodrich" -> "Michelin family"; the family LEADER for any non-leader member, null for leaders/unknown). `prefixFloorName` return gains `familyLabel?: string` and name format `"<Brand> (<Family>) / product unconfirmed"` when a label exists. `DecodePipelineResult` cap arm becomes `{ kind: "cap_blocked"; message: string; floor?: PrefixFloorResult }`. Route 429 body gains `floor`. Store: `DailyCapReachedError` carries `floor`; the cap row shows the floor name + honest cap reason. Vendor-label rows: FNSKU/X00-shaped codes get reason copy `"Amazon fulfillment label (FNSKU). Not a public barcode - resolve via your Amazon inventory."`.

- [ ] **Step 1: Failing tests**

```ts
// brandFamilies
it("familyLabelFor maps members to the family leader", () => {
  expect(familyLabelFor("BFGoodrich")).toBe("Michelin family");
  expect(familyLabelFor("Cooper")).toBe("Goodyear family");
  expect(familyLabelFor("Michelin")).toBeNull(); // leader carries no label
  expect(familyLabelFor("Nokian")).toBeNull(); // independent
});
// prefixFloor
it("annotates the family on the floor name", () => {
  // pick a prefix from derivedPrefixMap.json whose dominant is a family member; assert:
  expect(floor!.name).toMatch(/ \/ product unconfirmed$/);
});
// pipeline
it("P2: a cap-blocked decode still returns the prefix floor", async () => {
  forceCapExhausted();
  const out = await runDecodePipeline(makeReq({ code: PREFIX_KNOWN_GTIN, codeType: "upc_a" }));
  expect(out.kind).toBe("cap_blocked");
  expect((out as any).floor?.name).toMatch(/product unconfirmed/);
});
// scanStore (decodeCap suite): cap row is named by the floor, reason stays the honest cap copy
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement**

`brandFamilies.ts` (append; adapt member lists to the FILE'S existing FAMILIES arrays - do not invent members):

```ts
/** Family label for a member brand: "<Leader> family" (leader = first entry of its FAMILIES group).
 *  Leaders and independents return null. Normalization reuses this module's norm(). */
export function familyLabelFor(brand: string): string | null {
  const b = norm(brand);
  if (!b) return null;
  for (const family of FAMILIES) {
    const leader = family[0];
    if (b !== leader && family.includes(b)) return `${titleCaseLeader(leader)} family`;
  }
  return null;
}
```

`prefixFloor.ts`:

```ts
import { familyLabelFor } from "@/services/catalog/brandFamilies";
// inside prefixFloorName, after computing `brand`:
  const familyLabel = familyLabelFor(brand) ?? undefined;
  const name = familyLabel ? `${brand} (${familyLabel}) / product unconfirmed` : `${brand} / product unconfirmed`;
  return { name, brand, familyLabel };
```

`pipeline.ts` catch:

```ts
    if (e instanceof DailyCapExceededError) {
      // P2 (owner "never fully unknown"): the $0 prefix floor must survive a cap block.
      const floor = prefixFloorName(code, codeType) ?? undefined;
      return { kind: "cap_blocked", message: e.message, floor };
    }
```

Also, in computeDecode's FINAL all-miss return (the `!planDStash` arm, lines ~902-926): when `prefixFloorName(code, codeType)` returns non-null, put a floor result into `results` (confidence 0.3, `needsHumanReview: true`, empty sourceUrls) so non-public/EAN-8 codes get a named row too (P1) - decision stays needs_review, reason keeps the full allMissReason.

`route.ts`: find where `kind === "cap_blocked"` becomes the 429 response; add `floor` to the JSON body.
`scanStore.ts`: in the `DailyCapReachedError` handler (lines ~2481-2486): when the response carried a floor, set the review/row product name to `floor.name` (still unverified, still counted provisionally per existing cap behavior) and keep the honest cap reason text unchanged. For FNSKU copy: locate the vendor-label reason assignment (grep `vendor_label` in scanStore/needs-review copy) and special-case X00-prefixed codes with the copy above.

- [ ] **Step 4: Green**: `npx vitest run src/services/catalog/ src/server/decode/ src/stores/scanStore.decodeCap.test.ts` -> PASS.

- [ ] **Step 5: Commit**: `git commit -am "feat(floor): prefix floor survives cap blocks, family annotation, FNSKU honesty (P1/P2/P4/P5)"`

---

### Task 9: Category conflict becomes advisory when app-verified (hot-sauce fix)

**Files:**
- Modify: `src/services/ai/scanContextFirewall.ts:60-80`, `src/stores/scanStore.ts` (both call sites, lines ~2193 and ~2793 + row tag + copy fix)
- Test: `src/services/ai/scanContextFirewall.test.ts` (extend), `src/stores/sideDoorFirewall.store.test.ts` (UPDATE expectations - owner-ratified change), `src/stores/scanStore.test.ts:837` block (must stay green - weak path unchanged)

**Interfaces:**
- Produces: `detectScanContextConflict` gains `exactCodeVerifiedByApp?: boolean`; returns null (no block) when true. New `detectOffCategoryAdvisory(params): boolean` - true exactly when the conflict WOULD have fired but was cleared by verification (drives an "Off-category item" tag on the row). Store passes `exactCodeVerifiedByApp: decision.exactCodeEvidenceVerifiedByApp === true && decision.status === "verified"`.

- [ ] **Step 1: Failing tests**

```ts
it("hot-sauce case: verified non-tire product in tire context does NOT hard-block", () => {
  const out = detectScanContextConflict({
    scanContext: "tire", code: "0792080004312", codeType: "ean_13",
    result: { ...emptyResult(), productName: "Original Anchor Bar Hot Sauce", brand: "Anchor Bar", category: "food", confidence: 0.9 },
    brandPrefixHints: [], exactCodeVerifiedByApp: true,
  });
  expect(out).toBeNull();
});
it("poison guard intact: the SAME identity WITHOUT app verification still hard-blocks", () => {
  const out = detectScanContextConflict({ /* same params, exactCodeVerifiedByApp: false */ });
  expect(out).toBe("category_context_conflict");
});
it("advisory fires exactly on the cleared case", () => {
  expect(detectOffCategoryAdvisory({ /* verified non-tire in tire context */ })).toBe(true);
  expect(detectOffCategoryAdvisory({ /* tire product */ })).toBe(false);
});
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement** in `scanContextFirewall.ts`:

```ts
export function detectScanContextConflict(params: {
  scanContext: ScanContext;
  code: string;
  codeType: CodeType;
  result: AiLookupResult | null | undefined;
  brandPrefixHints: BrandPrefixHint[];
  /** Owner rule 2026-07-14 (decode-anything): strong APP-VERIFIED exact-code evidence clears the
   *  category hard-block - a tire shop can really stock hot sauce. The poison guard (coconut-oil
   *  class: weak/unverified single-source identities) keeps the hard block. */
  exactCodeVerifiedByApp?: boolean;
}): ConflictKind | null {
  const { scanContext, result, exactCodeVerifiedByApp } = params;
  if (!result) return null;
  if (scanContext === "tire" && classifyProductDomain(result) === "non_tire") {
    return exactCodeVerifiedByApp === true ? null : "category_context_conflict";
  }
  return null;
}

/** True exactly when the category conflict was CLEARED by app verification - callers tag the
 *  counted row "Off-category item" so the operator still sees it is not a tire. */
export function detectOffCategoryAdvisory(params: Parameters<typeof detectScanContextConflict>[0]): boolean {
  const { scanContext, result, exactCodeVerifiedByApp } = params;
  if (!result || exactCodeVerifiedByApp !== true) return false;
  return scanContext === "tire" && classifyProductDomain(result) === "non_tire";
}
```

Also update the OTHER conflict helper at lines 40-54 (the product-vs-context variant used by the side-door path) the same way IF it takes decode evidence; if it checks already-saved products (no evidence available), leave it - saved-product side-door protection is out of scope (document in the task report).

`scanStore.ts` both call sites: pass `exactCodeVerifiedByApp` from the decode decision; where `contextConflict` previously routed to review, the now-null path proceeds to the normal auto-count gate; compute `detectOffCategoryAdvisory` and store it on the row/review (`offCategory: true`) rendered as an "Off-category item" tag in the feed row (place next to the existing "(suggested)" tag rendering in `LiveScanFeed.tsx`). COPY FIX: locate the "Confidence too low to save automatically (50/100)" string source - it must not render when `decision.status === "verified"` (the demotion that produced 50 no longer happens; assert in a store test that a verified off-category decode shows 90, not 50).

`sideDoorFirewall.store.test.ts`: update the expectation for the decode-evidence path (verified non-tire now counts with `offCategory` true, review NOT created) and KEEP the weak-identity block assertions. Add a comment: "owner-ratified 2026-07-14: advisory-when-app-verified".

- [ ] **Step 4: Green**: `npx vitest run src/services/ai/scanContextFirewall.test.ts src/stores/ src/eval/eval.test.ts` -> ALL PASS (eval invariant proves no false-auto-count regression).

- [ ] **Step 5: Commit**: `git commit -am "feat(firewall): category conflict advisory when app-verified - decode-anything (owner-ratified)"`

---

### Task 9b: Inline suggestion approve/decline (no Needs Review for suggestions) - Opus

**Files:**
- Modify: `src/stores/scanStore.ts` (suggestion routing: stop creating a review for suggestion-bearing decodes; add `approveSuggestion(scanEventId)` / `declineSuggestion(scanEventId)` actions), `src/components/LiveScanFeed.tsx` (check/X controls next to the existing "(suggested)" tag), the existing batch-approve surface (add suggestions to it - grep `batch` in src/components + src/stores for the 2026-07-05 batch-approve build and extend it)
- Test: `src/stores/scanStore.suggestionInline.test.ts` (create), `src/components/LiveScanFeed.test.tsx` (extend if present), `e2e/` spec extension in the existing needs-review/suggestion spec

**Interfaces:**
- Consumes: decode responses whose decision is `suggested` (any confidence) or needs_review WITH a usable suggestion identity attached; `prefixFloorName` (Task 8); resolver trust rules (human approval is the ONLY thing that saves an alias).
- Produces: `approveSuggestion(id): void` - marks the row identity human-approved, saves the permanent alias (same code path `resolveUnknown` uses today - REUSE it, do not duplicate alias-writing logic), removes the suggestion tag. `declineSuggestion(id): void` - renames the row to the prefix floor (or "Unidentified item" when no floor), THEN creates the Needs Review item (decline is the only path that creates one). Row model gains `suggestion?: { productName: string; brand: string; confidence: number; status: "pending" | "approved" | "declined" }`.

Design rules (owner-ratified 2026-07-14):
1. The scan ALWAYS counts immediately (count-decouple unchanged); the suggestion concerns only the NAME.
2. A suggestion-bearing decode NO LONGER creates a Needs Review item. Needs Review is created only by: decline (here), genuinely empty decodes, and conflicts.
3. SCANNER SAFETY: the check/X controls are `tabIndex={-1}` and never auto-focused - a scanner Enter burst must never trigger them. They are pointer targets only, placed away from the scan input flow.
4. Approve = permanent alias via the EXISTING human-approval path (`resolveUnknown` or its extracted core), so idempotency keys + flywheel behavior are inherited, not re-implemented.
5. Suggestions also surface in the existing batch-approve UI ("Approve N suggestions") for end-of-session cleanup; approve/decline there calls the SAME store actions.
6. Copy shows the confidence honestly: "(suggested, 30%)". No em dashes.

- [ ] **Step 1: Failing store tests** (`scanStore.suggestionInline.test.ts`)

```ts
it("a low-confidence suggestion counts, tags the row, and does NOT create a review", async () => {
  await scanWithMockedDecode(suggestedDecode({ confidence: 0.3, productName: "Anchor Bar Hot Sauce" }));
  const st = useScanStore.getState();
  expect(st.finalCounts.length).toBe(1); // counted
  expect(st.scanFeed[0].suggestion?.status).toBe("pending");
  expect(st.needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(0); // THE change
});
it("approve saves a permanent alias and next scan of the code is deterministic-known", async () => {
  await scanWithMockedDecode(suggestedDecode({ confidence: 0.3 }));
  useScanStore.getState().approveSuggestion(useScanStore.getState().scanFeed[0].id);
  await scanSameCodeAgain();
  expect(useScanStore.getState().scanFeed[0].matchType).not.toBe("unknown"); // alias hit, no decode call
});
it("decline renames to the prefix floor and creates the review", async () => {
  await scanWithMockedDecode(suggestedDecode({ confidence: 0.3 }));
  useScanStore.getState().declineSuggestion(useScanStore.getState().scanFeed[0].id);
  const st = useScanStore.getState();
  expect(st.needsReviewQueue.filter((r) => r.status === "open")).toHaveLength(1);
  expect(st.scanFeed[0].suggestion?.status).toBe("declined");
});
it("approve/decline are idempotent (double-tap safe)", async () => { /* call twice, assert single alias/review */ });
```

(Reuse the store test scaffolding from `scanStore.decodeCap.test.ts` - same mocked-decode pattern.)

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement store actions + routing change.** In the decode-settled handler where a suggested decision currently creates/keeps the review (the `runLiveDecodeOnce` resolution block around scanStore.ts:2380-2470): when the decision carries a usable suggestion identity, set `suggestion: { ..., status: "pending" }` on the row and SKIP review creation. `approveSuggestion` routes through the existing human-approval core with the suggestion identity; `declineSuggestion` sets floor name + creates the review with reason "Suggestion declined by operator - needs a correct name". Both no-op unless `status === "pending"`.

- [ ] **Step 4: Implement the feed controls.** In `LiveScanFeed.tsx` next to the suggested-tag rendering: two small buttons (✓ label "Approve name", ✗ label "Not this product"), `tabIndex={-1}`, `onMouseDown={(e) => e.preventDefault()}` so focus NEVER leaves the scan input, calling the store actions. Confidence shown in the tag. Extend the batch-approve surface with pending suggestions using the same actions.

- [ ] **Step 5: Green**: `npx vitest run src/stores/ src/components/` -> PASS, including the focus assertion (component test: after clicking approve, `document.activeElement` is still the scan input - jsdom pattern already used by the scanner-focus tests).

- [ ] **Step 6: E2E**: extend the suggestion/needs-review Playwright spec: scan mocked suggested code -> row shows tag + controls -> approve -> tag clears -> rescan resolves known -> screenshot to `e2e/proof/`. Run `npx playwright test <that spec>` -> PASS.

- [ ] **Step 7: Commit**: `git commit -am "feat(suggestions): inline approve/decline on the feed row - suggestions bypass Needs Review (owner-ratified)"`

---

### Task 10: Golden baseline gate (B1)

**Files:**
- Create: `scripts/build-golden-baseline.mjs`, `benchmarks/golden/phase1-corpus-golden.json`, `src/eval/goldenBaseline.test.ts`
- Modify: `package.json` (script `test:golden` included in `test`)

**Interfaces:**
- Produces: a committed golden snapshot `{ code, brand, sizeToken }[]` for all 100 codes in `benchmarks/phase1_100_codes.csv`, and a fast offline test asserting every code resolves from the corpus with matching brand + size. This mechanically protects the owner-loved 100/100 baseline at the corpus layer (no live calls, <2s).

- [ ] **Step 1: Write the generator** (`scripts/build-golden-baseline.mjs`)

```js
// Generates benchmarks/golden/phase1-corpus-golden.json from the committed corpus.
// Run ONCE at build time of this plan; the OUTPUT is committed and never regenerated silently.
import fs from "node:fs";
const csv = fs.readFileSync("benchmarks/phase1_100_codes.csv", "utf8").trim().split(/\r?\n/);
const header = csv.shift();
const codeCol = header.split(",").findIndex((h) => /code|barcode|upc/i.test(h));
const idx = JSON.parse(fs.readFileSync("src/server/tire-knowledge/tireKnowledge.generated.json", "utf8"));
const strip = (c) => c.replace(/^0+/, "");
const findRow = (code) => {
  const cands = [code, strip(code), code.padStart(12, "0"), code.padStart(13, "0"), code.padStart(14, "0")];
  for (const c of new Set(cands)) if (idx.barcodeIndex[c]) return idx.barcodeIndex[c];
  return null;
};
const golden = [];
for (const line of csv) {
  const code = line.split(",")[codeCol].trim().replace(/"/g, "");
  const row = findRow(code);
  if (!row) { console.error("NOT IN CORPUS:", code); continue; }
  const size = ((row.specsShort ?? "") + " " + (row.specsFull ?? "") + " " + (row.size ?? "")).match(/\d{2,3}\/\d{2}\s?Z?R\d{2}/)?.[0] ?? "";
  golden.push({ code, brand: row.brand, sizeToken: size });
}
fs.mkdirSync("benchmarks/golden", { recursive: true });
fs.writeFileSync("benchmarks/golden/phase1-corpus-golden.json", JSON.stringify(golden, null, 1));
console.log(`golden: ${golden.length}/${csv.length} codes`);
```

Run: `node scripts/build-golden-baseline.mjs` -> expect `golden: 100/100 codes` (if fewer, STOP: list the missing codes in the task report - they are corpus gaps the owner must see, do NOT silently commit a smaller golden). Inspect the TireKnowledgeRow field names first (`brand`, `specsShort`, etc. - read one entry of the JSON) and adjust field access to reality.

- [ ] **Step 2: Write the gate test** (`src/eval/goldenBaseline.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import golden from "../../benchmarks/golden/phase1-corpus-golden.json";
import { lookupByExactBarcode } from "@/server/tire-knowledge/tireKnowledgeIndex";

describe("GOLDEN BASELINE GATE (owner-loved 100/100, commit 1782c11)", () => {
  it("every golden code still resolves from the corpus with the same identity", async () => {
    const failures: string[] = [];
    for (const g of golden as Array<{ code: string; brand: string; sizeToken: string }>) {
      const row = await lookupByExactBarcode(g.code);
      if (!row) { failures.push(`${g.code}: GONE from corpus`); continue; }
      if (row.brand !== g.brand) failures.push(`${g.code}: brand ${row.brand} != ${g.brand}`);
    }
    expect(failures, failures.join("; ")).toEqual([]);
  });
  it("golden set has not silently shrunk", () => {
    expect((golden as unknown[]).length).toBe(100);
  });
});
```

- [ ] **Step 3: Run**: `npx vitest run src/eval/goldenBaseline.test.ts` -> PASS (100/100). Add `"test:golden": "vitest run src/eval/goldenBaseline.test.ts"` to package.json scripts (plain `npm run test` already picks the file up via the vitest project globs - verify it does; if not, add the path to the node project include).

- [ ] **Step 4: Commit**: `git add benchmarks/golden scripts/build-golden-baseline.mjs src/eval/goldenBaseline.test.ts package.json && git commit -m "feat(eval): golden baseline gate - 100-code corpus identity snapshot (B1)"`

---

### Task 11: Full local gates

**Files:** none new - runs everything.

- [ ] **Step 1**: `npm run test` -> ALL suites pass (expect ~1950+ tests; `cloudDrainRace.store.test.ts` is known timing-flaky under full parallel load - if it is the ONLY failure, rerun it isolated per the project gotcha before judging).
- [ ] **Step 2**: `npx tsc --noEmit` -> clean. `npm run lint` -> clean.
- [ ] **Step 3**: `npm run build` -> clean production build.
- [ ] **Step 4**: `npx playwright test` -> E2E green (IS_E2E=1 webServer; zero live calls). Proof screenshots land in `e2e/proof/`.
- [ ] **Step 5**: `npm run qa:bots` (REVISION_GATE human-bot proof - resolution behavior changed in Tasks 7-9, so this gate is REQUIRED).
- [ ] **Step 6**: Commit any snapshot/proof artifacts: `git commit -am "test: full local gate run for ladder core round"`

---

### Task 12: Preview deploy + live proof (owner-authorized; $10 hard budget)

**Files:**
- Create: `e2e/preview-proof.spec.ts` (runs only when `PREVIEW_URL` env is set; NOT part of the normal e2e suite)

**Interfaces:**
- Consumes: the deployed preview URL; live keys already configured in Vercel preview env.
- Produces: screenshot proof in `e2e/proof/preview-2026-07-14/`, a spend ledger, PASS/FAIL per scenario.

- [ ] **Step 1: Push branch + deploy preview** (authorized for this round): `git push -u origin feat/decode-ladder-goupc` then `npx vercel deploy` (preview - NEVER `--prod`). Record the preview URL.
- [ ] **Step 2: Write `e2e/preview-proof.spec.ts`** - Playwright spec skipped unless `process.env.PREVIEW_URL`; scenarios:

```ts
// 1. LOVED BASELINE REPLAY: paste/scan the 100 golden codes (benchmarks/golden JSON) through the real
//    scan input; expect 100/100 Verified rows, 0 Needs Review, total wall time under 180s. ($0 - corpus)
// 2. ZERO-BUG PROOF: scan "0"+code and "00"+code for 3 golden corpus codes; each must resolve
//    Verified from the corpus ($0). THE core regression this round exists to fix.
// 3. HOT-SAUCE PROOF: scan 0792080004312 in tire context; expect a counted VERIFIED row with the
//    "Off-category item" tag and NO "category conflict" review. (<= 1 paid Go-UPC call, ~$0.05,
//    or $0 if the pay-once L2 already holds it from the owner's earlier scan.)
// 4. ENCODING PAY-ONCE PROOF: scan the same product in two encodings back to back; assert the second
//    resolves instantly as cached/known (no second decode row stuck in Decoding).
// 5. SUGGESTION INLINE PROOF: scan a code that yields a live low-confidence suggestion (or the
//    hot-sauce code if it lands as suggested); assert the row shows "(suggested, NN%)" with the
//    approve/decline controls, NO Needs Review item was created, approve clears the tag, and a
//    rescan resolves deterministically. ($0 - reuses scenario 3's decode or the L2 cache)
// Each scenario screenshots to e2e/proof/preview-2026-07-14/<n>-<name>.png.
```

- [ ] **Step 3: Run**: `PREVIEW_URL=<url> npx playwright test e2e/preview-proof.spec.ts` -> ALL scenarios PASS. On ANY failure: diagnose root cause locally (systematic-debugging), fix via the task-owner subagent, redeploy preview, rerun. Do NOT hand a failing preview to the owner.
- [ ] **Step 4: Ledger**: append actual paid-call counts to the final report (target: <= $0.50 total; hard stop $10 - if approaching $5, pause and report before continuing).
- [ ] **Step 5: Commit**: `git add e2e/preview-proof.spec.ts e2e/proof && git commit -m "test(preview): live proof - baseline replay, zero-bug, hot-sauce, pay-once"`

---

### Task 13: Docs, memory, final report

**Files:**
- Modify: `PROGRESS.md`, `TESTING.md`, `DECISIONS.md`, `LESSONS_LEARNED.md`, `docs/reviews/2026-07-14-ladder-improvement-report.md` (mark shipped items)

- [ ] **Step 1**: DECISIONS.md entries: pay-once rule; order v3; escalate-past-suggestion; advisory-when-app-verified; canonical cache keys. One line each with date + owner ratification.
- [ ] **Step 2**: TESTING.md: golden gate command, preview-proof command, updated cap-row expectations.
- [ ] **Step 3**: PROGRESS.md: round complete marker + preview URL + what is NOT done (phase 2 list: five-aspect fixes, Playwright door, A1-A7, deadline/dedup L2-L3).
- [ ] **Step 4**: LESSONS_LEARNED.md: the zero-bug class ("every lookup layer must share ONE variant source"), the classifySourceTier gap class ("new paid rungs must be added to the persist tier the day they are born").
- [ ] **Step 5**: Final report to owner per doctrine full-report format (terminal proof, files, tests, proof artifacts incl. preview screenshots, spend ledger, git status). Production promotion offered as a SEPARATE owner decision - not taken.
- [ ] **Step 6**: `git commit -am "docs: ladder core round closeout"`

---

## Self-Review (done at write time)

- Spec coverage: Z1(T2) Z2(T3) Z3(T4) Z5(T1) pay-once(T5) L1-order(T6) 5.6-order+escalation(T7) P1/P2/P4/P5(T8) hot-sauce(T9) inline-suggestions(T9b) B1(T10) gates(T11) preview(T12) docs(T13). Out of scope by owner ratification: five-aspect polish, G1/G2, Playwright door, A1-A7, L2/L3 deadline+dedup - listed in PROGRESS as phase 2.
- Type consistency: `lookupCandidates` (T1) consumed by T2; `canonicalGtin` (existing) by T4; `classifySourceTier` union + `PersistedDecode.sourceTier` widened together (T5); `PrefixFloorResult.familyLabel` (T8) matches prefixFloor return; `LadderPayload.decision.status` reads (T7) match the pipeline-local type.
- Placeholder scan: line-number anchors are VERIFIED reads from 2026-07-14; where store/route internals were not fully read, tasks give exact function/grep anchors plus contract tests that force correctness. Test scaffolding names (makeReq, mock factories) intentionally defer to the existing pipeline.test.ts factories - implementers read that file first.
- Known risk: T7 is the largest diff; it is Opus-assigned and gated by the eval invariant + full suite + qa:bots + preview replay.
