# Plan A — Count Decouple + Breaker Loosening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that every scan is counted the instant it is captured, so scanning 174 codes always yields a count of 174 — regardless of whether the AI lookup succeeds, fails, is rate-limited, is offline, or is shut off by the circuit breaker.

**Architecture:** Today an unknown scan is only counted as a *side effect* of the async AI decode completing (inside `liveDecode`'s success block, its `catch`, or `applyDecodeFallback`). When the decode is gate-blocked (breaker open / daily cap / offline) on the cloud path, nothing counts and the scan is stranded in Needs Review. This plan extracts the existing "count one provisional row, idempotently" logic into a shared store method, calls it **synchronously in `processScan` for every unresolved scan before any network work**, and relies on the existing `status !== "known"` / already-counted guards so the later decode handlers enrich-but-never-recount. It also raises the circuit-breaker failure threshold so a burst does not trip it after 3 codes.

**Tech Stack:** TypeScript, Zustand store (`src/stores/scanStore.ts`), Vitest (node + jsdom projects), existing test harness `createTestScanStore({ db: new MockDb() })`.

## Global Constraints

- Every scan counts immediately; counting is NEVER gated by AI lookup, circuit breaker, daily cap, rate limit, or online state. (Owner rule: "scan N = count N".)
- Counting must remain idempotent: re-scanning the same code increments the SAME product row; a later decode response must NOT add a second count for a code already counted.
- Unique codes must never create duplicate product rows.
- Known scans (approved alias / verified product) keep their existing instant deterministic count path — do not change it.
- No em dash or en dash in user-facing copy. Use normal punctuation.
- Keep `src/services/*` pure — no React / `next/*` imports. Store logic stays in `src/stores/scanStore.ts`.
- All existing unit suites must still pass (`npm run test`), TypeScript must stay clean (`npx tsc --noEmit`), and `npm run build` must succeed.
- This plan does NOT rename "Needs Review" to "Suggested", does NOT wire the Turso catalog lookup, does NOT touch grounding or the prefix fallback. Those are Plans B–E. Plan A only guarantees the COUNT.

---

## Verification Gate (MANDATORY — governs every task, and every future plan A–E)

Owner rule: **prove each task in the real running app before moving on. Never advance while the current task is red.**

For EACH task below, in order:

1. **Unit gate:** the task's Vitest test(s) pass, AND the full suite (`npm run test`) stays green.
2. **Browser gate (Playwright, real UI):** for any task that changes user-visible behavior, drive the ACTUAL app and prove it — do not trust unit tests alone. Launch the dev server on port 3100, mock `/api/ai-lookup` with the `NO_AI_STATUS` pattern from `e2e/scan.spec.ts` (so zero live tokens are spent), scan through `page.getByTestId("scanner-input")`, and assert the on-screen result. Save a screenshot to `e2e/proof/`. For store-only tasks that add no new UI (Tasks 1, 3, 4), the browser gate is a smoke check: the app boots and the existing `e2e/scan.spec.ts` still passes.
3. **Loop until fixed:** if EITHER gate fails, STOP. Use `superpowers:systematic-debugging` to find the root cause, fix it, then re-run BOTH gates. Repeat until both are green.
4. **Hard stop between tasks:** do NOT start task N+1 until task N is green on both gates. No batching past a red task.

Commands:
- Unit: `npm run test`  (single suite: `npx vitest run <path>`)
- E2E: `npm run test:e2e`  (run `npx playwright install chromium` once first)

---

## File Structure

- Modify: `src/stores/scanStore.ts`
  - Add a new store method `ensureProvisionalCount(code, reason)` — the single idempotent "count this scan once as a provisional row" primitive. It is the extracted body of the current `applyDecodeFallback`.
  - Refactor `applyDecodeFallback(reviewId, reason)` to delegate to `ensureProvisionalCount`.
  - In `processScan`, for every unresolved (unknown / conflict) scan, call `ensureProvisionalCount` synchronously right after the Needs Review item is created, before firing `cloudCatalogResolve` / `liveDecode`.
- Modify: `src/services/circuitBreaker.ts`
  - Raise `FAILURE_THRESHOLD` from `3` to `12`.
- Test: `src/stores/countAlways.store.test.ts` (new) — the core invariants (count under every blocked condition, no double count, 174 integration).
- Test: `src/services/circuitBreaker.test.ts` (existing) — update the "opens after the failure threshold" test to the new constant.

## Interfaces (shared across tasks)

- `ensureProvisionalCount(code: string, reason: string): void`
  - Idempotent. If a still-counted, non-archived product already carries `code` as an identifier (`primaryBarcode | gtin | upc | ean | primarySku`), returns without counting.
  - Otherwise: creates a provisional `Product` (`verified:false, provisional:true, primaryBarcode: code, name: "Unidentified item (barcode <code>)"` or `"(code <code>)"` per `decodeBarcodeStructure(...).checkDigitValid`), finds the open scan-feed row for `code` with `status !== "known"`, increments `finalCounts` once for it via `incrementInventoryCount`, and flips that feed row to `status: "known"`, `decodeStatus: "suggested"`, `syncStatus: "synced"`, `quantityAfterScan: <new qty>`. Leaves any matching Needs Review row OPEN, setting its `suggestedProductName` fallback + `reason` if empty.
- The existing decode handlers rely on `scanFeed.find(e => e.cleanCode === code && e.status !== "known")` returning the row to count. After `ensureProvisionalCount` runs, that row's `status` is `"known"`, so those handlers find nothing to increment and only enrich. This is the idempotency mechanism — preserve it.

---

### Task 1: Extract the idempotent provisional-count primitive

**Files:**
- Modify: `src/stores/scanStore.ts` — add `ensureProvisionalCount` to the store interface (near line 305 where `applyDecodeFallback` is declared) and to the implementation (adjacent to `applyDecodeFallback`, currently at lines 2027-2074). Refactor `applyDecodeFallback` to delegate.
- Test: `src/stores/countAlways.store.test.ts` (new)

**Interfaces:**
- Produces: `ensureProvisionalCount(code, reason)` (see shared Interfaces above).
- Consumes: existing `incrementInventoryCount`, `decodeBarcodeStructure`, `detectCodeType`, `idFactory`, `now` already in scope in scanStore.ts.

- [ ] **Step 1: Write the failing test**

Create `src/stores/countAlways.store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

function totalCount(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

describe("ensureProvisionalCount is idempotent", () => {
  it("counts an unresolved code exactly once even if invoked twice", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // A scan feed row must exist for the code (processScan normally makes it).
    store.getState().processScan("111111111116");
    const before = totalCount(store);
    // Direct double-invoke of the primitive must not add a second count.
    store.getState().ensureProvisionalCount("111111111116", "test");
    store.getState().ensureProvisionalCount("111111111116", "test");
    expect(totalCount(store)).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stores/countAlways.store.test.ts`
Expected: FAIL — `ensureProvisionalCount is not a function` (method does not exist yet).

- [ ] **Step 3: Add the method and delegate from `applyDecodeFallback`**

In the store interface block, next to `applyDecodeFallback: (reviewId: string, reason: string) => void;`, add:

```typescript
  /** Idempotent primitive: count one provisional row for `code` (create it if absent), keyed by an
   *  already-existing scan-feed row. Safe to call any number of times for the same code (never double
   *  counts). Used synchronously by processScan and by applyDecodeFallback. */
  ensureProvisionalCount: (code: string, reason: string) => void;
```

In the implementation, add `ensureProvisionalCount` by moving the body of the current `applyDecodeFallback` (lines 2027-2074) into it, keyed by `code` instead of `reviewId`. Then make `applyDecodeFallback` delegate:

```typescript
      ensureProvisionalCount: (code, reason) => {
        const st0 = get();
        // IDEMPOTENT: if this code is already counted (any path), do nothing - never double count.
        const counted = new Set(st0.finalCounts.map((c) => c.productId));
        const existing = st0.products.find(
          (p) =>
            counted.has(p.id) &&
            p.status !== "archived" &&
            [p.primaryBarcode, p.gtin, p.upc, p.ean, p.primarySku].map((c) => (c ?? "").trim()).includes(code),
        );
        if (existing) return;
        const struct = decodeBarcodeStructure(code, detectCodeType(code));
        const fbName = struct.checkDigitValid ? `Unidentified item (barcode ${code})` : `Unidentified item (code ${code})`;
        const provId = `prod-${idFactory()}`;
        const provProduct: Product = {
          id: provId, businessId: st0.businessId, name: fbName, brand: "", category: "", specsShort: "",
          specsFull: "", primarySku: "", primaryBarcode: code, gtin: "", upc: "", ean: "", vendorCodes: [],
          aliases: [], imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "ai_gemini",
          confidence: 0, verified: false, provisional: true, createdAt: now(), createdBy: "ai", updatedAt: now(), updatedBy: "ai",
        };
        const ev = st0.scanFeed.find((e) => e.cleanCode === code && e.status !== "known");
        let counts = st0.finalCounts;
        let qty = 0;
        if (ev) {
          const r = incrementInventoryCount(counts, { ...ev, matchedProductId: provId, status: "known", quantityDelta: 1 }, idFactory);
          counts = r.counts;
          qty = r.count.quantity;
        }
        set((st) => ({
          products: [...st.products, provProduct],
          finalCounts: counts,
          needsReviewQueue: st.needsReviewQueue.map((r) =>
            r.cleanCode === code && r.status === "open"
              ? { ...r, decodeStatus: "needs_review", reason: r.reason || reason, suggestedProductName: r.suggestedProductName || fbName }
              : r,
          ),
          scanFeed: st.scanFeed.map((e) =>
            ev && e.id === ev.id
              ? { ...e, matchedProductId: provId, status: "known", quantityAfterScan: qty, decodeStatus: "suggested", syncStatus: "synced" as const, reason: e.reason || reason }
              : e,
          ),
        }));
      },

      applyDecodeFallback: (reviewId, reason) => {
        const review = get().needsReviewQueue.find((r) => r.id === reviewId);
        if (!review || review.status !== "open") return;
        get().ensureProvisionalCount(review.cleanCode, reason);
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/stores/countAlways.store.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing fallback tests to confirm no regression**

Run: `npx vitest run src/stores/autoDecode.test.ts`
Expected: PASS (the delegated `applyDecodeFallback` behaves identically).

- [ ] **Step 6: Commit**

```bash
git add src/stores/scanStore.ts src/stores/countAlways.store.test.ts
git commit -m "refactor: extract idempotent ensureProvisionalCount from applyDecodeFallback"
```

---

### Task 2: Count every unresolved scan synchronously in `processScan`

**Files:**
- Modify: `src/stores/scanStore.ts` — inside `processScan`, in the unknown/conflict branch, right after the Needs Review item is created and pushed (currently around lines 1156-1171, immediately before the catalog-first / decode dispatch at line 1177). Also cover the `existingOpen` case so a repeat unknown still counts.
- Test: `src/stores/countAlways.store.test.ts`

**Interfaces:**
- Consumes: `ensureProvisionalCount` from Task 1.

- [ ] **Step 1: Write the failing tests (count under every blocked condition)**

Append to `src/stores/countAlways.store.test.ts`:

```typescript
describe("every scan counts synchronously, regardless of lookup state", () => {
  it("counts an unknown scan when AI is OFF", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("222222222229");
    expect(totalCount(store)).toBe(1);
  });

  it("counts an unknown scan when OFFLINE", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setOnline(false);
    store.getState().processScan("333333333332");
    expect(totalCount(store)).toBe(1);
  });

  it("counts an unknown scan when the circuit breaker is OPEN", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, emergencyStop: true });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().processScan("444444444445");
    expect(totalCount(store)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/stores/countAlways.store.test.ts -t "every scan counts"`
Expected: FAIL — count is `0` (today unresolved scans are not counted synchronously; the AI-off case never counts at all).

- [ ] **Step 3: Add the synchronous count in `processScan`**

In `processScan`, after the block that creates and enqueues the new `UnknownCodeReview` (the `if (!existingOpen) { ... }` body ending near line 1171) and before the catalog-first `const codes = ...` line (1180), add:

```typescript
        // OWNER RULE "scan N = count N": count EVERY unresolved scan immediately, synchronously, before any
        // network work. The AI/catalog lookup below only ENRICHES this provisional row (name/verified); it
        // can never again decide whether the scan counts. ensureProvisionalCount is idempotent, so the later
        // decode handlers (which filter on status !== "known") find nothing to re-count.
        get().ensureProvisionalCount(cleaned.cleanCode, resolution.reason);
```

Also handle the repeat-scan case: move this call so it runs for BOTH the `existingOpen` and new-review branches. Place it immediately after `set((s) => ({ scanFeed: [event, ...s.scanFeed] }));` at line 1113 (which runs in both branches), instead of inside `if (!existingOpen)`. Confirm placement with the test in Step 4 (a repeat scan of the same code must reach count 2).

- [ ] **Step 4: Run to verify pass, and add the repeat-scan test**

Append:

```typescript
  it("re-scanning the same unknown code increments the SAME row (count 2, one product)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("555555555558");
    store.getState().processScan("555555555558");
    expect(totalCount(store)).toBe(2);
    expect(store.getState().finalCounts.length).toBe(1);
  });
```

Run: `npx vitest run src/stores/countAlways.store.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/stores/countAlways.store.test.ts
git commit -m "feat: count every unresolved scan synchronously (scan N = count N)"
```

---

### Task 3: A later decode response enriches but never double-counts

**Files:**
- Modify: `src/stores/scanStore.ts` — none expected; the existing `status !== "known"` filters in the DECODE-EVERYTHING block (line 1873), the `catch` block (line 1999), and the verified `resolveUnknown(..., applyToCount: true)` path (line 1820) must be confirmed idempotent against a pre-counted row. If the verified `resolveUnknown` path double-counts, add an early guard there.
- Test: `src/stores/countAlways.store.test.ts`

**Interfaces:**
- Consumes: mocked `fetch` returning decode responses (pattern copied from `autoDecode.test.ts`).

- [ ] **Step 1: Write the failing/guard tests**

Append (reuse the `VERIFIED` / `SUGGESTED` fixtures and `stub` / `failStub` helpers from `autoDecode.test.ts` — copy them into this file's top, they are small and self-contained):

```typescript
import { vi } from "vitest";

const VERIFIED = {
  providerNames: ["gemini", "openai"],
  results: [{ productName: "Coca-Cola Classic", brand: "Coca-Cola", upc: "878106003504", sourceUrls: ["https://gs1.org/878106003504"], verifiedFacts: [], guesses: [], aliases: [], confidence: 0.97 }],
  decision: { status: "verified", confidence: 0.97, reason: "Verified AI Decode", evidenceStrength: "snippet", exactCodeEvidenceVerifiedByApp: true, crossCheck: { decision: "agree" } },
};
function stub(resp: object) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => resp })) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}
function failStub() {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}
function aiOnStore() {
  const store = createTestScanStore({ db: new MockDb() });
  store.getState().setAiStatus({ geminiConfigured: true, openaiConfigured: true, missingKeys: [] });
  store.getState().updateSettings({ aiLookupEnabled: true });
  return store;
}

describe("decode response enriches, never double counts", () => {
  it("a VERIFIED decode leaves the total at 1 and upgrades the row", async () => {
    const store = aiOnStore();
    const { restore } = stub(VERIFIED);
    try {
      store.getState().processScan("878106003504");
      expect(totalCount(store)).toBe(1); // counted synchronously, before the decode resolves
      await vi.waitFor(() => expect(store.getState().scanFeed.some((e) => e.decodeStatus === "verified")).toBe(true));
    } finally {
      restore();
    }
    expect(totalCount(store)).toBe(1); // still 1 after enrichment
  });

  it("a FAILED decode leaves the total at 1", async () => {
    const store = aiOnStore();
    const { restore } = failStub();
    try {
      store.getState().processScan("878106003504");
      expect(totalCount(store)).toBe(1);
      await vi.waitFor(() => expect(store.getState().aiLookupLogs.length).toBeGreaterThan(0));
    } finally {
      restore();
    }
    expect(totalCount(store)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to observe**

Run: `npx vitest run src/stores/countAlways.store.test.ts -t "never double counts"`
Expected: The FAILED case PASSES (the `catch` block's `status !== "known"` filter already skips re-count). The VERIFIED case may FAIL if `resolveUnknown(..., applyToCount: true)` counts again on top of the synchronous count.

- [ ] **Step 3: If the VERIFIED case double-counts, guard `resolveUnknown`**

Only if Step 2 shows the verified path double-counting: in `resolveUnknown`, before it applies the count for an `applyToCount` create, add an early idempotency check that reuses an already-counted provisional product carrying this code (mirror the guard in `ensureProvisionalCount`), and increment that existing row's identity rather than creating a second count. Write the guard using the same `finalCounts`→`productId` set + identifier-match pattern. (Do not invent a new field; reuse `products`, `finalCounts`, and the identifier list `[primaryBarcode, gtin, upc, ean, primarySku]`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/stores/countAlways.store.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/stores/scanStore.ts src/stores/countAlways.store.test.ts
git commit -m "test: prove decode responses enrich provisional rows without double counting"
```

---

### Task 4: Loosen the circuit breaker so a burst does not trip it after 3

**Files:**
- Modify: `src/services/circuitBreaker.ts:14` — `FAILURE_THRESHOLD`.
- Test: `src/services/circuitBreaker.test.ts` (existing) — the "opens after the failure threshold" case.

**Interfaces:**
- Consumes / Produces: `FAILURE_THRESHOLD` constant.

- [ ] **Step 1: Update the existing breaker test to the new threshold**

In `src/services/circuitBreaker.test.ts`, find the "opens after the failure threshold" test (around line 14) and change it to record 11 failures → still `closed`, and the 12th failure → `open`. Use the existing `recordFailure` / `initBreaker` helpers already imported in that file. Example shape (match the file's existing style):

```typescript
  it("opens after the failure threshold", () => {
    let s = initBreaker();
    for (let i = 0; i < 11; i++) s = recordFailure(s, 0);
    expect(s.state).toBe("closed");
    s = recordFailure(s, 0);
    expect(s.state).toBe("open");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/services/circuitBreaker.test.ts -t "opens after the failure threshold"`
Expected: FAIL — breaker opens at 3, not 12.

- [ ] **Step 3: Raise the threshold**

In `src/services/circuitBreaker.ts` line 14:

```typescript
export const FAILURE_THRESHOLD = 12;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/services/circuitBreaker.test.ts`
Expected: PASS (whole file — check no other test hard-codes 3; if one does, update it to the new constant, not a literal).

- [ ] **Step 5: Commit**

```bash
git add src/services/circuitBreaker.ts src/services/circuitBreaker.test.ts
git commit -m "fix: raise circuit-breaker threshold 3 -> 12 so a scan burst does not trip it"
```

---

### Task 5: Integration — scan all 174 real codes, expect count 174

**Files:**
- Test: `src/stores/countAlways.store.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the 174-code integration test (decode stubbed to always fail = worst case)**

Append:

```typescript
const CODES_174 = `697662129691 697662131854 697662137658 697662133469 697662126256 697662129325 697662128489 697662131007 697662124627 697662099659 697662099673 697662099734 697662099789 697662099796 697662099802 697662099819 697662099826 697662099895 697662101550 697662101611 697662102885 697662103042 697662117612 697662099598 697662099604 697662099628 697662099642 697662099727 697662099741 697662099833 697662099864 697662099871 697662099901 697662101567 697662114208 697662116592 697662117650 697662117698 697662135708 5452000649706 697662087694 697662096580 697662099581 697662099611 697662099758 086699368492 086699077691 086699087829 086699159991 086699224750 086699232816 086699258427 086699315670 086699373304 086699428301 086699473608 086699042132 086699051462 086699060099 086699117120 086699137685 086699143921 086699152176 086699165459 086699212016 086699236098 086699300546 086699332844 086699339157 086699397317 086699430304 086699431998 086699525222 086699624710 086699679611 086699778642 086699835338 086699855275 086699880628 086699979674 086699998538 086699014313 086699034588 086699061348 086699146441 086699146878 086699182692 086699188540 086699202130 086699202819 715459275427 715459286782 715459288922 715459268832 715459268849 715459271962 715459276622 715459279173 715459279180 715459279623 715459279647 715459286775 715459290635 715459303878 715459304158 715459305315 715459305353 715459343911 715459248278 715459268962 715459279050 715459279166 715459288915 715459332915 715459343652 715459220038 715459230815 715459260041 715459268900 715459268948 715459269006 715459271931 715459271948 715459271979 715459273683 715459286256 715459286768 715459288946 715459290963 715459302802 715459305490 715459313648 715459328529 715459343799 715459361816 715459309115 715459258581 715459268788 715459284375 715459305339 715459309047 715459309160 715459313631 715459317998 715459322428 715459342297 715459342334 715459258901 715459262281 715459305346 715459308996 715459309061 715459309078 715459309122 715459309177 715459313686 715459318001 715459319565 715459322404 715459241538 715459298297 715459305377 715459305414 715459306954 715459308620 715459308972 715459309023 715459309108 715459309139 715459309146 715459309184 715459309337 715459313624 715459313655`.trim().split(/\s+/);

describe("174-code burst always counts 174", () => {
  it("counts every one of the 174 unique codes even with all decodes failing", async () => {
    const store = aiOnStore();
    const { restore } = failStub();
    try {
      for (const code of CODES_174) store.getState().processScan(code);
      expect(CODES_174.length).toBe(174);
      expect(totalCount(store)).toBe(174);
      expect(store.getState().finalCounts.length).toBe(174); // 174 unique -> 174 rows
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/stores/countAlways.store.test.ts -t "174-code burst"`
Expected: PASS — `totalCount` is 174, `finalCounts.length` is 174.

- [ ] **Step 3: Commit**

```bash
git add src/stores/countAlways.store.test.ts
git commit -m "test: 174-code burst counts exactly 174 with all decodes failing"
```

---

### Task 6: Browser proof (Playwright, real UI) + full gate

**Files:**
- Create: `e2e/count-always.spec.ts`
- Modify (only if needed): `src/components/FinalCountTable.tsx` — add `data-testid="final-count-body"` to the table `<tbody>` if it does not already expose a stable row container.
- Verify (no change expected): full suite, typecheck, build.

- [ ] **Step 1: Write the Playwright proof that unknown scans count in the real app**

Create `e2e/count-always.spec.ts` (mirrors the real patterns in `e2e/scan.spec.ts` — same fixtures, same `NO_AI_STATUS` mock, same `scan()` helper, so no live tokens):

```typescript
import { test, expect, type Page } from "./fixtures";

const NO_AI_STATUS = {
  liveEnabled: false, autoDecodeOnScan: false, geminiEnabled: false, openaiEnabled: false,
  geminiConfigured: false, openaiConfigured: false, premiumFallback: false, mode: "off",
  dailyLimit: 200, missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true,
};

// Six unique codes from the owner's real 174-code batch, none in the seed catalog.
const UNKNOWNS = ["697662129691", "697662131854", "697662137658", "086699368492", "715459275427", "5452000649706"];

async function scan(page: Page, code: string) {
  const input = page.getByTestId("scanner-input");
  await input.click();
  await input.pressSequentially(code, { delay: 2 });
  await input.press("Enter");
}

test("every unknown scan counts, even with AI off (scan N = count N)", async ({ page }) => {
  await page.route("**/api/ai-lookup", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: NO_AI_STATUS });
    return route.fulfill({ json: {} }); // a POST must never fire on this no-key flow
  });
  await page.goto("/login");
  await page.getByTestId("login-button").click();
  await page.waitForURL("**/scan");
  await expect(page.getByTestId("scanner-input")).toBeFocused();

  for (const code of UNKNOWNS) await scan(page, code);

  // Raw feed kept every event.
  await expect(page.getByTestId("scan-feed-body").locator("tr")).toHaveCount(UNKNOWNS.length);
  // Plan A invariant: every unknown was COUNTED -> one final-count row per unique code.
  await expect(page.getByTestId("final-count-body").locator("tr")).toHaveCount(UNKNOWNS.length);
  await page.screenshot({ path: "e2e/proof/count-always.png", fullPage: true });
});
```

- [ ] **Step 2: Run it and read the failure**

Run: `npm run test:e2e -- count-always`
Expected on first run: it may FAIL on the `final-count-body` locator if `FinalCountTable` has no such testid. If so, add `data-testid="final-count-body"` to the `<tbody>` element in `src/components/FinalCountTable.tsx` (a one-attribute change — do not restructure the component), then re-run.

- [ ] **Step 3: Loop until the browser proof is green**

Re-run `npm run test:e2e -- count-always` until it PASSES: feed has 6 rows, final-count table has 6 rows, screenshot written to `e2e/proof/count-always.png`. If it fails for any other reason, use `superpowers:systematic-debugging` — do NOT weaken the assertions to force green.

- [ ] **Step 4: Full unit suite**

Run: `npm run test`
Expected: PASS. If any pre-existing test asserted that an AI-off / gate-blocked unknown does NOT count (the old "the user chose not to decode" behavior), it now conflicts with the owner rule — update that test to the new invariant (count == 1) and note it in the commit. Do NOT weaken the new count tests to satisfy an old assertion.

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add e2e/count-always.spec.ts src/components/FinalCountTable.tsx e2e/proof/count-always.png
git commit -m "test(e2e): browser-proof that every unknown scan counts (scan N = count N)"
git add -A
git commit -m "test: reconcile pre-existing count assertions with scan N = count N rule" || echo "nothing to reconcile"
```

---

## Self-Review

**Spec coverage:**
- #2 "count every scan instantly" → Tasks 1, 2, 5.
- #3 "loosen breaker + breaker never blocks counting" → Task 4 (threshold) + Task 2 breaker-open test (counting independent of breaker).
- #4 "52 leftovers count too" → covered by Task 2/5 (an unresolved code with no catalog/decode still counts).
- Idempotency / no double count → Task 3.
- Owner's per-step verification + loop-until-fixed + no-advance-while-red → the Verification Gate section (governs all tasks) + Task 6 real Playwright browser proof (`e2e/count-always.spec.ts`).
- Not in scope (Plans B-E): Turso lookup, Verified/Suggested rename, grounding ladder, prefix fallback. Explicitly excluded in Global Constraints.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step shows real code or a real command. Task 3 Step 3 is conditional (only if the verified path double-counts) but specifies the exact guard pattern to add, not a vague instruction.

**Type consistency:** `ensureProvisionalCount(code, reason)` signature is identical in the interface declaration, the implementation, and both call sites (`processScan`, `applyDecodeFallback`). `totalCount`, `stub`, `failStub`, `aiOnStore` helpers are defined once in the test file and reused. `FAILURE_THRESHOLD` is referenced by name, never by literal.
