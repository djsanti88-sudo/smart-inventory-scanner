# Recall + Hardening Round Implementation Plan (2026-07-15)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the ratified core round (gates, push, preview proof, docs), then ship the owner-ratified recall round (Z4 prompt sentence, G1 structured outputs, G2 env model, A3 bad-scan feedback, A6 tire quota steering, A4 outcome ledger, meros reality benchmark + anti-enumeration guard, ASIN public-page door), then the hardening round (B2 corpus drift, B5 auto-count battery, B8 cap race, B3/B6/B7 batch, settings drift fix), plus DT-harvest Sunday scheduling and repo housekeeping.

**Architecture:** No ladder reorder - order v3 is ratified and shipped. Every change lives INSIDE a rung or beside the ladder: the GPT rung gets schema-guaranteed output and an env-selectable model; the scan intake gets a 0ms check-digit misread gate; the free rungs get tire-prefix steering; decode outcomes get an append-only ledger; Fetch V2's evidence layer gets an anti-enumeration guard and an ASIN door.

**Tech Stack:** Next.js 16 / TypeScript / Vitest (node + jsdom projects) / Playwright / Zustand / Turso + SQLite via LadderStorage.

## Global Constraints

- Orchestrator is Fable; every subagent dispatch passes an explicit model: `sonnet` for implementation tasks, `opus` for review/verification. Omitting model is a violation (owner rule 2026-07-14).
- Automated tests NEVER call live providers. Unit tests mock `fetch`; E2E uses `page.route` + `IS_E2E=1` webServer.
- Wrong identity is FAILURE; unknown is ACCEPTABLE. Nothing in this plan may weaken decideDecode, EvidenceVerifier, the auto-count gate, or the poison guard.
- Pay-once rule: never charge the daily cap on two paths of one request (LESSONS L12); exactly one `chargePaidSlot()` per genuine paid compute.
- Services stay pure: no React / next/* imports under `src/services/`.
- No em dash or en dash in user-facing copy.
- Gated actions pre-authorized by owner 2026-07-15: branch push AFTER Task 1 gates pass; Task 3 preview deploy + live proof with a $10 HARD budget; DT-harvest scheduled Sunday night. Production promote remains NOT authorized.
- TDD on every code task: failing test first, then minimal implementation, then green run, then commit.

## PLAN AMENDMENTS v2 (2026-07-15 three-angle review round - THESE SUPERSEDE any conflicting task step below)

Adversarial (Opus) + simplicity (Sonnet) + demo-risk (Sonnet) reviews scored the original 6/10. Owner ordered full execution today with these corrections applied. Where a task step below conflicts with an amendment, THE AMENDMENT WINS.

**AM-1 (BLOCKER fix, Task 12b redesigned).** The owner-visible 36-70s freeze is CLIENT-side: `scanStore.ts` decode fetch has no abort/timeout, and the client's `budgetMs` is dead (route parses it at route.ts:182 but never passes it to `runDecodePipeline`). Task 12b now has THREE parts, in order: (a) client AbortController on the decode fetch with timeout = `decodeBudgetMs + 7000ms` margin; on abort, the scan row shows the honest reason "Decode is taking longer than expected - it keeps working in the background; check Needs Review shortly" and the row stays needs_review (never lost, never blocks the next scan); (b) thread `budgetMs` from the route into `runDecodePipeline` and derive the ladder deadline from it; (c) `DECODE_LADDER_TOTAL_MS` default is 15000 (NOT 60000) - a deadline the client actually outlives. The runLadder `opts.deadlineAt` mechanism from the original task stands. The golden gate runs offline where rungs are instant - the deadline never trips there (confirmed; do not make the golden gate time-sensitive).

**AM-2 (Task 8 / A3 narrowed).** Legitimate 12-14 digit non-GS1 codes (in-store number-system-2 price-embedded, ITF-14 wrappers, warehouse numerics) fail GS1 check digits BY DESIGN. The misread reason must be additive, never terminal: copy = "Barcode check digit fails - this may be a scanner misread (rescan to confirm) or a store-internal code. You can still link it to a product." The row REMAINS aliasable exactly like any needs_review row (no affordance removed). The auto-decode skip stands (a bad-check-digit code cannot decode via any GTIN rung and dooms paid rungs), but add THREE new test cases: a number-system-2 UPC (starts with 2, bad plain check), a 13-digit non-GS1 warehouse numeric, an ITF-14 wrapper - each asserting the row is still resolvable/aliasable via the normal review flow and the reason mentions BOTH possibilities.

**AM-3 (Task 9 / A6 gate hardened).** TRUE blast radius of a false steer: empty free rungs -> `freeSuggestion = null` -> TOTAL-MISS branch -> chargePaidSlot() + full paid ladder. A false steer COSTS money, not just 2 free lookups. Steering therefore requires BOTH: (a) a strong tire-prefix hint AND (b) matched prefix length >= 8 digits (never a bare 6-7 digit shared company prefix). Add the failing test: "a non-tire UPC sharing a 6-digit company prefix with a tire brand is NOT steered." Document the blast radius in the module doc comment.

**AM-4 (Tasks 5+6+7 MERGED into one task, one commit).** Same file, same test file: `feat(gpt-rung): Z4 zero-padding sentence + G2 env model + G1 json_schema`. G1 carries a HARD verification gate: before commit, verify the `text.format json_schema` + `tools:[web_search]` + `reasoning.effort` combination against current OpenAI docs (context7/platform docs); if docs are ambiguous, G1 ships behind graceful degradation - schema requested, regex fallback retained (it already is), and one live smoke call is executed during the Task 3 preview session (inside the $10 budget) to confirm no 400. If the live smoke 400s, revert the G1 hunk only (keep Z4+G2).

**AM-5 (Task 10 / A4 relocated + trimmed).** The ledger append moves to the runDecodePipeline OUTER level (route choke point, after `payload`/`cached` are known, ~pipeline.ts:1018) so it sees ALL exits: Plan D verified early-return, ladder win, all-miss fallback, AND cap_blocked. Never inside computeDecode. Drop the eval-candidate export (`nondecode-candidates.jsonl`) from this round - the rollup script prints per-rung counts + top miss reasons only. Joined-coalesced waiters (AM-6) do not append (winner-only) - document that in the module comment.

**AM-6 (Task 12c corrected).** (a) forceRefresh computations are NEVER registered in the in-flight map (`if (!opts?.forceRefresh) inFlight.set(...)`) and never join one - add the test "a forceRefresh call is not joined by a later normal call and vice versa". (b) Add the cap-exhausted burst test: 3 concurrent calls under an exhausted cap - all three reject with the cap error; assert compute ran at most twice (slot cleared on throw allows one retry; no unbounded stampede). (c) Document that joined waiters report `cached: true` (telemetry approximation, acceptable).

**AM-7 (Task 12 / ASIN door reachability).** The pattern-URL door currently lives inside `if (needsDiscovery && deps.discovery.length > 0)` (fetchV2/index.ts:148) - with zero discovery keys the door NEVER RUNS. Move the pattern-URL door OUT of that guard (it is free and needs no discovery provider), preserving its position before paid search. The Task 12 engine test MUST use an EMPTY discovery array to prove keyless reachability. This also benefits public barcodes in keyless environments.

**AM-8 (Task 11 trimmed + guard fixed).** Meros probe: 20 codes x 2 URLs (40 fetches), not 84x2 - if 0/20 yield identity, the answer is conclusive. Anti-enumeration guard: add a "survives" fixture of a DENSE legitimate fitment/spec page (many part numbers + prose interleaved) and strengthen the heuristic: enumeration requires >= 50 digit runs AND digit-ratio > 0.5 AND at least 30% of runs pairwise-sequential (monotonic neighbors within a small delta). A spec table with scattered codes must survive.

**AM-9 (Task 17 completed).** Also fix the persisted store default: `scanStore.ts:367` `decodeBudgetMs: 13000` -> `8000` (existing users' persisted 13000 silently clamps server-side; new default must match reality). Settings UI uses `DECODE_BUDGET_MIN_MS`/`DECODE_BUDGET_MAX_MS` imports.

**AM-10 (Serialization directive - MANDATORY).** `gptFromScratch.ts` tasks (merged 5/6/7) = ONE agent. `pipeline.ts`-touching tasks run STRICTLY SEQUENTIALLY in this order: Task 10 (introduces decodeStartedAt) -> Task 12b (consumes it) -> Task 12c (shares the total-miss branch) -> Task 9 (free-rung block). Never parallel. Independent parallel groups: {merged-GPT}, {Task 8}, {Task 11 guard}, {Tasks 13,14,15,16}, {Task 17}. Task 12 (fetchV2 index) may run parallel to pipeline tasks EXCEPT its pipeline patternUrls hunk, which lands with Task 9's serialized slot.

**AM-11 (Tasks 4+19 merged; execution protocol).** Housekeeping (.gitignore) rides with the closeout docs commit. Every implementer agent SELF-CHECKS (runs its own tests + the neighboring suites) before handing off; an Opus reviewer verifies against the plan + amendments; the orchestrator (Fable) does the final check and bounces it back on any finding. Full gate sweep re-runs after the last pipeline-touching task and before the preview re-proof.

**AM-12 (Demo-prep track - runs FIRST, tonight, before and during Phase 0).** Owner presents tomorrow (mostly tires, scanner gun + typed codes, fresh Vercel preview). (a) Preview deploy happens EARLY; verify on the LIVE preview: provider keys reported configured by GET /api/ai-lookup (booleans only), emergency stop off, breaker closed, daily cap headroom, GPT ladder $ budget - raise `AI_LOOKUP_MAX_COST_DEV`/budget env for the demo window if needed ($3/day default is too tight for rehearsal + demo). (b) Rehearse: 15 golden tire codes + any real tires available scan instantly and correctly on the preview. (c) Build the non-tire demo list LIVE tonight: try 5-8 common retail codes on the preview, keep the 3-5 that resolve fast and RIGHT - they are cached (pay-once) so tomorrow they are instant; that list is the demo script. (d) Clear breaker/emergency localStorage state in the demo browser profile after rehearsal; record one clean dry-run video as the stage fallback. (e) Script the Needs Review line for bosses: the app refuses to guess - wrong counts cost money; unknowns queue for one-time human teaching.

## File Structure (created/modified across the plan)

- Modify: `src/services/ai/gptFromScratch.ts` (Z4 sentence, G2 env model, G1 json_schema)
- Modify: `src/services/ai/gptFromScratch.test.ts`
- Create: `src/services/upc/misread.ts` + `src/services/upc/misread.test.ts` (A3 pure helper)
- Modify: `src/services/resolver.ts` + `src/services/resolver.test.ts` (A3 reason)
- Modify: `src/stores/scanStore.ts` (A3 skip auto-decode on misread)
- Create: `src/server/upc/freeRungSteering.ts` + `.test.ts` (A6)
- Modify: `src/server/decode/pipeline.ts` (A6 wiring, A4 ledger write, ASIN pattern URL)
- Modify: `src/server/upc/storage.ts` + `storage.test.ts` (A4 appendOutcome)
- Create: `scripts/decode-outcomes-report.mjs` (A4 rollup)
- Create: `scripts/probe-meros.mjs` (meros reality benchmark)
- Modify: `src/server/upc/ladder.ts` + `ladder.test.ts` (L2 total deadline)
- Modify: `src/services/ai/decodeCache.ts` + its test (L3 in-flight coalescing)
- Create: `src/server/upc/paidWorkPossible.ts` + `.test.ts` (L6 keyless charge gate)
- Modify: `src/services/fetchV2/pageEvidence/junkRules.ts` + `pageEvidence.test.ts` (anti-enumeration guard)
- Modify: `src/services/fetchV2/index.ts` + `engine.test.ts` (ASIN door gate)
- Create: `src/server/tire-knowledge/corpusDrift.test.ts` (B2)
- Create: `src/stores/autoCountBattery.test.ts` (B5)
- Modify: `src/services/security/aiSpendGuard.test.ts` (B8)
- Modify: `src/services/ai/decodeBudget.test.ts` (B6), `src/services/ai/tireSpecs.test.ts` (B7)
- Create: `src/eval/envGate.test.ts` (B3)
- Modify: `src/app/(app)/settings/page.tsx` (budget copy drift fix)
- Modify: `.gitignore` (housekeeping)

---

# PHASE 0 - CORE ROUND CLOSEOUT

### Task 1: Full local gates (T11)

**Files:** none modified - verification only.

**Interfaces:**
- Consumes: the 10 shipped core-round commits (`724f391`..`a17b66e`).
- Produces: a green gate record pasted into the Task 4 closeout report; the precondition for the branch push.

- [ ] **Step 1: Clean environment precheck**

Run: `git status --short` (expect only known strays: `mockups/`, `.serena/`, `scripts/polish-eval-results.json`, modified `.claude/settings.local.json`, `.superpowers/sdd/task-3-report.md`). Kill any stale dev server on port 3100.

- [ ] **Step 2: Typecheck + unit suites + build**

Run: `npm run proof:full`  (= `tsc --noEmit && vitest run && next build`)
Expected: exit 0. Known flake allowance: `cloudDrainRace.store.test.ts` may fail ONLY under full parallel load; if it fails, rerun isolated: `npx vitest run src/stores/cloudDrainRace.store.test.ts` and record both results.

- [ ] **Step 3: Golden baseline gate**

Run: `npm run test:golden`
Expected: 2 passed (84 golden codes resolve with identical identity; count exactly 84).

- [ ] **Step 4: E2E**

Run: `npx playwright install chromium` (once, if needed) then `npm run test:e2e`
Expected: exit 0, proof screenshots under `e2e/proof/`.

- [ ] **Step 5: QA bots (Human Bot Proof Gate for the suggestion-row/advisory changes)**

Run: `npm run qa:bots`
Expected: exit 0. This gate is REQUIRED because Task 9/9b of the core round changed scanner-facing resolution UI.

- [ ] **Step 6: Record results**

Write the exact command outputs (pass counts, exit codes) into `.superpowers/sdd/t11-gate-record.md`. Do not commit yet (Task 4 commits docs together).

### Task 2: Push the branch (owner-authorized after Task 1 passes)

**Files:** none.

- [ ] **Step 1: Verify Task 1 was green** (all gates exit 0; flake documented if any).

- [ ] **Step 2: Push branch only** (no PR merge, no deploy, master untouched):

```bash
git push -u origin feat/decode-ladder-goupc
```

Expected: branch visible on GitHub. STOP if the remote rejects (LFS or size issues) - report, do not force.

- [ ] **Step 3: Verify** `git status` shows branch tracking `origin/feat/decode-ladder-goupc` and `git rev-list --count origin/feat/decode-ladder-goupc..HEAD` = 0.

### Task 3: Preview deploy + live proof (T12, $10 HARD budget)

**Files:** none modified. Live-spend task - owner authorized 2026-07-15.

- [ ] **Step 1:** Deploy PREVIEW (never production): `npx vercel deploy` from the repo root (or the project's established preview flow). Record the preview URL.
- [ ] **Step 2:** Confirm preview env has TURSO + provider keys per `.env.example` names (via Vercel dashboard - never print values).
- [ ] **Step 3:** Replay the 100-code owner baseline against the preview using the established benchmark flow (`npm run benchmark` pointed at the preview per its docs, or the qa:bots:live config). HARD STOP conditions: computed floor reaches $10, OR any wrong auto-count appears (wrong identity = failure; abort and report).
- [ ] **Step 4:** Compare to the loved baseline (100/100 verified, 0 review, ~98s, commit 1782c11 reference). Any regression = report with per-code reasons, do NOT proceed to Task 4 sign-off.
- [ ] **Step 5:** Report spend as "computed floor $X; true spend = provider console" (Paid API Cost Truth Rule).

### Task 4: Closeout docs (T13)

**Files:**
- Modify: `PROGRESS.md` (core round complete marker + reconciliation marker)
- Modify: `LESSONS_LEARNED.md` (what the zero-bug class taught; meros probe reality)
- Modify: `TESTING.md` (test:golden, gate list)

- [ ] **Step 1:** Update the three docs with the Task 1-3 results (exact numbers, no padding).
- [ ] **Step 2:** Commit: `git commit -m "docs: core round closeout - gates, push, preview proof (T11-T13)"`
- [ ] **Step 3:** Push the docs commit (same pre-authorized branch push).

---

# PHASE 1 - RECALL ROUND

### Task 5: Z4 - GTIN zero-padding sentence in the GPT prompt (owner-ratified 2026-07-15)

**Files:**
- Modify: `src/services/ai/gptFromScratch.ts` (the `promptFor` template, lines ~45-57)
- Test: `src/services/ai/gptFromScratch.test.ts`

**Interfaces:**
- Consumes: `gptFromScratch(code, deps)` with `deps.fetchImpl` mock capturing the request body.
- Produces: unchanged signature; prompt text gains one sentence.

- [ ] **Step 1: Write the failing test**

```ts
it("Z4: prompt teaches GTIN zero-padding equivalence (code property, not an answer hint)", async () => {
  let sentBody: any = null;
  const fetchImpl = (async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ output: [] }) } as any;
  }) as typeof fetch;
  await gptFromScratch("0049000006346", { apiKey: "k", fetchImpl });
  expect(sentBody.input).toContain("zero-padding variants");
  expect(sentBody.input).toContain("shortest form");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/services/ai/gptFromScratch.test.ts -t "Z4"`
Expected: FAIL - `expected ... to contain 'zero-padding variants'`.

- [ ] **Step 3: Minimal implementation** - insert ONE sentence into `promptFor` right after `Search the web. `:

```ts
const promptFor = (code: string) =>
  `Identify the product for barcode ${code}. Search the web. ` +
  `GTIN zero-padding variants of a code (the same digits with leading zeros added or removed) ` +
  `are the SAME product - search the shortest form too. Return JSON only: ` +
  // ... rest of the existing template unchanged ...
```

- [ ] **Step 4: Run the whole file** - `npx vitest run src/services/ai/gptFromScratch.test.ts` - Expected: all pass (existing prompt tests may assert other substrings; update NONE of them - the sentence is additive).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/gptFromScratch.ts src/services/ai/gptFromScratch.test.ts
git commit -m "feat(gpt-rung): Z4 zero-padding sentence in prompt (owner-ratified 2026-07-15)"
```

### Task 6: G2 - GPT model name from env (`GPT_LADDER_MODEL`)

**Files:**
- Modify: `src/services/ai/gptFromScratch.ts` (line ~91, `model: "gpt-5.5"`)
- Test: `src/services/ai/gptFromScratch.test.ts`

**Interfaces:**
- Produces: request body `model` = `process.env.GPT_LADDER_MODEL?.trim() || "gpt-5.5"`.

- [ ] **Step 1: Write the failing test**

```ts
describe("G2: GPT_LADDER_MODEL env override", () => {
  afterEach(() => { delete process.env.GPT_LADDER_MODEL; });
  const capture = () => {
    let sentBody: any = null;
    const fetchImpl = (async (_u: any, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ output: [] }) } as any;
    }) as typeof fetch;
    return { fetchImpl, body: () => sentBody };
  };
  it("defaults to gpt-5.5 when unset", async () => {
    const c = capture();
    await gptFromScratch("049000006346", { apiKey: "k", fetchImpl: c.fetchImpl });
    expect(c.body().model).toBe("gpt-5.5");
  });
  it("uses the env model when set", async () => {
    process.env.GPT_LADDER_MODEL = "gpt-6-preview";
    const c = capture();
    await gptFromScratch("049000006346", { apiKey: "k", fetchImpl: c.fetchImpl });
    expect(c.body().model).toBe("gpt-6-preview");
  });
});
```

- [ ] **Step 2: Run to verify the second case fails** (`npx vitest run src/services/ai/gptFromScratch.test.ts -t "G2"`).

- [ ] **Step 3: Minimal implementation**

```ts
        model: process.env.GPT_LADDER_MODEL?.trim() || "gpt-5.5",
```

- [ ] **Step 4: Green run** on the file; also `npx vitest run src/services/ai/gptLadderRung.test.ts` (wrapper must be unaffected).

- [ ] **Step 5: Commit** `feat(gpt-rung): G2 model name from GPT_LADDER_MODEL env (default gpt-5.5)`. Also add `GPT_LADDER_MODEL` (name only) to `.env.example`.

### Task 7: G1 - Responses API structured outputs (json_schema)

**Files:**
- Modify: `src/services/ai/gptFromScratch.ts` (request body + keep regex parse as fallback)
- Test: `src/services/ai/gptFromScratch.test.ts`

**Interfaces:**
- Produces: request body gains `text: { format: { type: "json_schema", ... } }`. Parse path unchanged (schema makes the regex fallback vestigial, not removed - belt and suspenders).

- [ ] **Step 1: Write the failing test**

```ts
it("G1: requests structured output via json_schema so non-JSON replies are impossible", async () => {
  let sentBody: any = null;
  const fetchImpl = (async (_u: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ output: [] }) } as any;
  }) as typeof fetch;
  await gptFromScratch("049000006346", { apiKey: "k", fetchImpl });
  expect(sentBody.text?.format?.type).toBe("json_schema");
  expect(sentBody.text?.format?.name).toBe("product_identity");
  expect(sentBody.text.format.schema.required).toEqual(
    expect.arrayContaining(["brand", "productName", "confidence", "exactCodeFound", "basis", "sourceUrls"]),
  );
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Minimal implementation** - add to the request body in `gptFromScratch`:

```ts
        text: {
          format: {
            type: "json_schema",
            name: "product_identity",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["brand", "productName", "category", "specs", "gtin", "confidence", "exactCodeFound", "basis", "sourceUrls"],
              properties: {
                brand: { type: "string" },
                productName: { type: "string" },
                category: { type: "string" },
                specs: { type: "string" },
                gtin: { type: "string" },
                confidence: { type: "number" },
                exactCodeFound: { type: "boolean" },
                basis: { type: "string" },
                sourceUrls: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
```

Keep the existing `Return JSON only: {...}` prompt text AND the regex extraction untouched (harmless with schema on; protects against any API edge case).

- [ ] **Step 4: Green run** on the file. Then verify against current OpenAI Responses API docs (context7 or platform docs) that `text.format.json_schema` is the correct shape for the `/v1/responses` endpoint BEFORE committing; if docs disagree, match the documented shape and update the test to it.

- [ ] **Step 5: Commit** `feat(gpt-rung): G1 structured outputs via json_schema - kills the non-JSON wasted-call class`.

### Task 8: A3 - instant bad-scan feedback (check-digit misread gate)

A GTIN-shaped code whose GS1 check digit fails (and which is not a valid UPC-E) is a scanner misread. Today it wastes a full ladder run (GTIN rungs skip it, fetchv2/gpt burn time) and lands as a junk review row. After this task it gets an instant honest reason and NO auto-decode.

**Files:**
- Create: `src/services/upc/misread.ts`
- Test: `src/services/upc/misread.test.ts`
- Modify: `src/services/resolver.ts` (unknown-branch reason, lines ~63-82)
- Modify: `src/services/resolver.test.ts`
- Modify: `src/stores/scanStore.ts` (skip decodeOnce when misread)

**Interfaces:**
- Produces: `isLikelyMisreadGtin(code: string): boolean` from `src/services/upc/misread.ts`.
- Consumes: `isGtinShaped`, `isValidCheckDigit`, `expandUpcE` from `src/services/upc/gtin.ts`.

- [ ] **Step 1: Write the failing helper test** (`src/services/upc/misread.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { isLikelyMisreadGtin } from "./misread";

describe("isLikelyMisreadGtin (A3)", () => {
  it("valid UPC-A is not a misread", () => {
    expect(isLikelyMisreadGtin("049000006346")).toBe(false);
  });
  it("12-digit with wrong check digit IS a misread", () => {
    expect(isLikelyMisreadGtin("049000006345")).toBe(true);
  });
  it("13/14-digit with wrong check digit IS a misread", () => {
    expect(isLikelyMisreadGtin("0049000006345")).toBe(true);
    expect(isLikelyMisreadGtin("00049000006345")).toBe(true);
  });
  it("valid EAN-8 is not a misread", () => {
    expect(isLikelyMisreadGtin("96385074")).toBe(false);
  });
  it("8-digit failing EAN-8 check but expanding to a valid UPC-E/UPC-A is not a misread", () => {
    // any 8-digit code where expandUpcE returns non-null
    // construct one: take a valid UPC-A like 042100005264 -> its UPC-E form 04252614 (verify in test)
    const upcE = "04252614";
    expect(isLikelyMisreadGtin(upcE)).toBe(false);
  });
  it("8-digit failing BOTH ean-8 check and upc-e expansion IS a misread", () => {
    expect(isLikelyMisreadGtin("12345678")).toBe(true); // invalid EAN-8 check, ns 1 expansion invalid
  });
  it("non-GTIN shapes are never misreads (vendor labels, skus)", () => {
    expect(isLikelyMisreadGtin("X001ABC123")).toBe(false);
    expect(isLikelyMisreadGtin("BR-1234")).toBe(false);
    expect(isLikelyMisreadGtin("12345")).toBe(false);
  });
});
```

NOTE to implementer: verify the UPC-E fixture actually satisfies `expandUpcE(x) !== null` before relying on it; if not, compute a valid one in the test from `expandUpcE`'s rules and assert your fixture with `expect(expandUpcE(upcE)).not.toBeNull()` first.

- [ ] **Step 2: Run to verify it fails** (module does not exist).

- [ ] **Step 3: Implement** `src/services/upc/misread.ts`:

```ts
import { isGtinShaped, isValidCheckDigit, expandUpcE } from "@/services/upc/gtin";

/**
 * A3 (owner-ratified 2026-07-15): a GTIN-SHAPED code that fails the GS1 check digit is almost
 * certainly a scanner misread (dirty label, bad angle, camera blur). 8-digit codes get one more
 * chance: a failed EAN-8 check may still be a zero-suppressed UPC-E whose expansion validates.
 * Misreads are caught at 0ms - they never run the decode ladder and get an honest "rescan" reason.
 * NON-GTIN shapes (vendor labels, SKUs) are never misreads - they have no check digit to fail.
 */
export function isLikelyMisreadGtin(code: string): boolean {
  const t = (code ?? "").trim();
  if (!isGtinShaped(t)) return false;
  if (isValidCheckDigit(t)) return false;
  if (/^\d{8}$/.test(t) && expandUpcE(t) !== null) return false;
  return true;
}
```

- [ ] **Step 4: Green run** on the helper file.

- [ ] **Step 5: Write the failing resolver test** (add to `src/services/resolver.test.ts`):

```ts
it("A3: unknown GTIN-shaped code failing its check digit gets the misread reason", () => {
  const r = resolveRawScan("049000006345", [], [], "biz-1");
  expect(r.resolverStatus).toBe("needs_review");
  expect(r.reason).toContain("Scan misread");
  expect(r.reason).toContain("rescan");
});
it("A3: an APPROVED alias for a bad-check-digit code still resolves known (alias wins)", () => {
  // reuse the test file's existing alias/product fixtures pattern for a known match on "049000006345"
  // expect resolverStatus "known" - the misread reason only applies on the unknown branch
});
```

- [ ] **Step 6: Implement in `src/services/resolver.ts`** - extend the existing unknown-branch reason block (keep FNSKU honesty first):

```ts
  const isFnsku = codeType === "vendor_label" && cleaned.cleanCode.trim().toUpperCase().startsWith("X0");
  const misread = isLikelyMisreadGtin(cleaned.cleanCode);
  const reason = isFnsku
    ? "Amazon fulfillment label (FNSKU). Not a public barcode - resolve via your Amazon inventory."
    : misread
      ? "Scan misread - this barcode's check digit fails. Please rescan the item."
      : codeType === "vendor_label"
        ? "Vendor/Amazon label. Link it to a product once and it will count automatically after that."
        : "No approved alias or verified product matches this code yet.";
```

(import `isLikelyMisreadGtin` at the top; resolver stays pure - the import is a pure service.)

- [ ] **Step 7: scanStore - skip auto-decode on misread.** Find the auto-decode trigger in `src/stores/scanStore.ts` (the path that calls the decode pipeline for a needs_review scan; search `decodeOnce` / `aiLookupEnabled`). Add BEFORE the decode dispatch:

```ts
        // A3: a misread GTIN never runs the decode ladder - the honest fix is a rescan, not a lookup.
        if (isLikelyMisreadGtin(event.cleanCode)) return;
```

Write the store test first (in the existing decode-trigger test file, following its established mock pattern): a scan of `"049000006345"` produces a needs_review row with the misread reason and ZERO decode fetches; a scan of a valid unknown GTIN still triggers exactly one decode fetch.

- [ ] **Step 8: Full green run**: `npx vitest run src/services/resolver.test.ts src/services/upc/misread.test.ts src/stores/` - Expected: all pass, including poison guard and existing decode-cap store tests (untouched behavior for valid codes).

- [ ] **Step 9: Commit** `feat(scan): A3 instant misread feedback - bad check digit skips the ladder, honest rescan reason`.

### Task 9: A6 - free-rung tire steering

Tire-prefix codes never hit UPCitemdb/OFF (proven: 0 hits across all tire benchmarks). Skipping the two free rungs for them saves the 90/day UPCitemdb quota and 1-2s latency per tire unknown.

**Files:**
- Create: `src/server/upc/freeRungSteering.ts`
- Test: `src/server/upc/freeRungSteering.test.ts`
- Modify: `src/server/decode/pipeline.ts` (lines ~753-759, the `buildFreeLadderRungs` call)

**Interfaces:**
- Produces: `steerFreeRungs(code: string): { skip: boolean; reason: string }`.
- Consumes: `lookupTirePrefix` from `@/services/tire/tirePrefixLookup`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { steerFreeRungs } from "./freeRungSteering";

describe("A6 free-rung tire steering", () => {
  it("skips free rungs for a code with a STRONG tire prefix hint", () => {
    // pick a strong prefix from TIRE_PREFIX_HINTS, e.g. build a 13-digit code starting with a
    // known strong prefix key; assert skip true and the reason names the steering.
    const s = steerFreeRungs("0006148800123"); // implementer: use a REAL strong-hint prefix from tirePrefixHints
    expect(s.skip).toBe(true);
    expect(s.reason).toContain("tire-prefix steering");
  });
  it("does not skip for an unrecognized prefix", () => {
    const s = steerFreeRungs("0490000063462");
    expect(s.skip).toBe(false);
  });
  it("weak-only hints do NOT steer (only strong evidence skips a free lookup)", () => {
    // pick a weak-only prefix from TIRE_PREFIX_HINTS
    // expect skip false
  });
});
```

Implementer: pull one real strong-hint prefix and one weak-only prefix from `src/services/tire/tirePrefixHints.ts` and hard-code them in the test with a comment naming the source line.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
import "server-only";
import { lookupTirePrefix } from "@/services/tire/tirePrefixLookup";

/**
 * A6 (owner-ratified 2026-07-15): UPCitemdb/OpenFoodFacts have NEVER returned a tire (proven across
 * every benchmark). A code whose GS1 prefix carries a STRONG tire-brand hint skips both free rungs:
 * saves the 90/day UPCitemdb quota for codes that can actually hit and 1-2s latency per tire unknown.
 * Weak hints do NOT steer - a weak prefix is not evidence enough to forgo a free lookup.
 */
export function steerFreeRungs(code: string): { skip: boolean; reason: string } {
  const m = lookupTirePrefix(code);
  const strong = m?.brands.some((h) => h.weight === "strong") ?? false;
  if (strong) {
    return { skip: true, reason: `free rungs skipped: tire-prefix steering (${m!.prefix} -> ${m!.brands[0].brand}; UPCitemdb/OFF never stock tires)` };
  }
  return { skip: false, reason: "" };
}
```

- [ ] **Step 4: Green run** on the new test file.

- [ ] **Step 5: Wire into the pipeline** (`src/server/decode/pipeline.ts`, replacing the free-rung construction):

```ts
    const steering = steerFreeRungs(code);
    const freeRungs = steering.skip ? [] : buildFreeLadderRungs(code, { runUpcItemDb, runOpenFoodFacts });
    const freeRun = await runLadder(code, freeRungs);
    if (steering.skip) freeRun.reasons.push({ rung: "free-steering", reason: steering.reason });
```

(import `steerFreeRungs` at the top.) The empty-rungs path is identical to today's non-GTIN path (`buildFreeLadderRungs` already returns `[]` for non-GTINs), so the downstream `freeSuggestion` / total-miss branches need NO change.

- [ ] **Step 6: Run the pipeline's test file(s)** (`npx vitest run src/server/decode/`) - Expected: green; the steering reason appears in ladder reasons for a steered code (add one pipeline-level assertion if a pipeline unit test exists with mockable deps; otherwise the unit test on `steerFreeRungs` + the unchanged-path argument suffices, note it in the commit body).

- [ ] **Step 7: Commit** `feat(pipeline): A6 tire-prefix steering skips free rungs (quota + latency, reason recorded)`.

### Task 10: A4 - decode outcome ledger (append-only) + rollup report

Institutionalizes "trace every non-decode": every ladder decode appends one outcome row (rung reasons already exist in `ladderRun.reasons` - today they are discarded after the response). Offline rollup turns them into rung precision / miss-class tables and drafts eval-dataset candidates.

**Files:**
- Modify: `src/server/upc/storage.ts` (add `appendOutcome`, mirroring `appendArchive`)
- Modify: `src/server/upc/storage.test.ts`
- Modify: `src/server/decode/pipeline.ts` (one `appendOutcome` call at response assembly)
- Create: `scripts/decode-outcomes-report.mjs`

**Interfaces:**
- Produces (storage):

```ts
export interface DecodeOutcomeEntry {
  code: string;
  canonicalGtin: string;      // canonicalGtin(code) ?? code
  settledBy: string | null;   // rung name or null for a total miss
  status: string;             // decision.status or "cap_blocked" / "misread" etc.
  reasons: Array<{ rung: string; reason: string }>;
  durationMs: number;
  sourceTier: string | null;  // classifySourceTier output
  createdAt: string;          // ISO
}
export interface LadderStorage { /* existing members */ appendOutcome(entry: DecodeOutcomeEntry): Promise<void>; }
```

- Storage backends: Turso table `decode_outcomes` (INSERT-only: `id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, canonical_gtin TEXT, settled_by TEXT, status TEXT, reasons TEXT, duration_ms INTEGER, source_tier TEXT, created_at TEXT`); file adapter appends JSONL at `decode-outcomes/<YYYY-MM>.jsonl` (same bucketing as `decode-archive`).

- [ ] **Step 1: Write the failing storage test** (mirror the existing `appendArchive` describe block in `storage.test.ts`, including its "appending never rewrites existing lines" assertion, for both the file adapter and the Turso SQL-shape assertion).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `appendOutcome`** in both adapters of `storage.ts`, copying the `appendArchive` pattern exactly (append-only JSONL for file; INSERT-only for Turso; never UPDATE/DELETE).

- [ ] **Step 4: Green run**: `npx vitest run src/server/upc/storage.test.ts`.

- [ ] **Step 5: Pipeline write.** In `src/server/decode/pipeline.ts`, at the single point where the ladder response payload is finalized (after `ladderRun` resolves and the decision is known), add one fire-and-forget append (never blocks or fails the response):

```ts
    // A4 outcome ledger: append-only trace of WHY this decode ended how it did. Fire-and-forget -
    // a ledger failure must never affect the scan. (Owner standing order: trace every non-decode.)
    void (async () => {
      try {
        const store = await ladderStorage();
        await store.appendOutcome({
          code,
          canonicalGtin: canonicalGtin(code) ?? code,
          settledBy: ladderRun.settledBy ?? null,
          status: decision.status,
          reasons: ladderRun.reasons,
          durationMs: Date.now() - decodeStartedAt,
          sourceTier: classifySourceTier(reasonCode, providerNames),
          createdAt: new Date().toISOString(),
        });
      } catch { /* ledger is best-effort */ }
    })();
```

Implementer: place it where `ladderRun`, `decision`, `reasonCode`, `providerNames` are all in scope (the LadderPayload assembly); add `const decodeStartedAt = Date.now()` at `computeDecode` start. Skip entirely under `e2eMode()`.

- [ ] **Step 6: Rollup script** `scripts/decode-outcomes-report.mjs` (offline, $0): reads the month's JSONL (file mode) or `decode_outcomes` (Turso when env present); prints per-rung settled counts, per-status totals, top 10 miss reasons, and writes `reports/decode-outcomes-<YYYY-MM-DD>.md` plus `data/accuracy/nondecode-candidates.jsonl` (one line per needs_review outcome, `{ code, reasons, createdAt }`) for later curation into the eval set. Pure Node, no deps.

- [ ] **Step 7: Green run** of the storage tests + a manual script smoke: `node scripts/decode-outcomes-report.mjs` on an empty ledger prints "0 outcomes" and exits 0.

- [ ] **Step 8: Commit** `feat(ledger): A4 append-only decode outcome ledger + offline rollup (trace every non-decode)`.

### Task 11: Meros reality benchmark + anti-enumeration evidence guard

Live probe 2026-07-15: `meros.io/<7-digit-prefix>` pages are BARE sequential code enumerations (no product names, no company names); per-code pages 404 for every code tried; most prefixes 404. The meros door ALREADY EXISTS in `BARCODE_SOURCES` (`https://meros.io/${raw}`) and currently can only fetch 404s. Owner wants meros kept - so: measure it honestly, and make enumeration pages structurally harmless first.

**Files:**
- Modify: `src/services/fetchV2/pageEvidence/junkRules.ts` (+ its test in `pageEvidence.test.ts`)
- Create: `scripts/probe-meros.mjs`

**Interfaces:**
- Produces: a new junk rule; existing junk-rule call sites unchanged (the rule slots into the established `junkRules` evaluation the same way current rules do - implementer: read `junkRules.ts` first and match its exact rule shape).

- [ ] **Step 1: Write the failing junk-rule test** (in `pageEvidence.test.ts`, following the file's existing junk-rule test pattern):

```ts
it("anti-enumeration guard: a page that is mostly bare digit runs is junk-rejected", () => {
  // synthetic meros-style enumeration: 500 sequential 12-digit codes, whitespace-separated, ~no prose
  const codes = Array.from({ length: 500 }, (_, i) => String(39272000000 + i * 7).padStart(12, "0")).join(" ");
  const html = `<html><title>UPC Lookup for 0392720#####</title><body><h1>UPC Codes</h1>${codes}</body></html>`;
  // assert via the module's public junk evaluation that this page is rejected with a reason
  // naming "enumeration" - exact call shape per junkRules.ts's existing API.
});
it("anti-enumeration guard: a real product page with one code and prose survives", () => {
  const html = `<html><body><h1>Michelin Defender LTX M/S 275/60R20 115T</h1>
    <p>All-season truck tire. UPC 086699371942. In stock.</p></body></html>`;
  // assert NOT rejected by the enumeration rule.
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the rule** in `junkRules.ts` (match the file's existing rule structure; core predicate):

```ts
/**
 * Anti-enumeration guard (owner meros decision 2026-07-15): a page that mechanically lists
 * every possible code under a prefix "contains" ANY exact code - that is evidence-poison, not
 * evidence. Reject pages whose visible text is overwhelmingly bare digit runs with almost no
 * prose. Protects against every aggregator of this class, not just meros.io.
 */
export function isEnumerationPage(pageText: string): boolean {
  const text = (pageText ?? "").trim();
  if (text.length < 2000) return false; // short pages cannot be mass enumerations
  const digitRuns = text.match(/\d{8,14}/g) ?? [];
  if (digitRuns.length < 50) return false; // a real product page cites a handful of codes
  const digitChars = digitRuns.join("").length;
  return digitChars / text.length > 0.5; // majority of the page is bare code digits
}
```

Wire it into the junk evaluation with reason `"enumeration page - lists codes en masse, proves nothing"`.

- [ ] **Step 4: Green run**: `npx vitest run src/services/fetchV2/` (all 6+ suites - the guard must not reject any existing fixture page; if it does, the thresholds are wrong, fix the RULE not the fixtures).

- [ ] **Step 5: Benchmark script** `scripts/probe-meros.mjs` ($0, throttled 1 req/s, Chrome UA):
reads `benchmarks/golden/phase1-corpus-golden.json`, for each code fetches `https://meros.io/<code>` and `https://meros.io/<first-7-of-gtin13>`, records HTTP status, page size, whether the page contains ANY alphabetic product/company identity near the code (regex: a 3+ word Title Case run within 200 chars of the code), and whether `isEnumerationPage` fires. Writes `reports/meros-probe-<date>.md` with: per-code hit table, identity-yield % (the decision number), enumeration %, and a ToS note line. No secrets sent; public site; read-only.

- [ ] **Step 6: Run it**: `node scripts/probe-meros.mjs` - Expected: completes in ~3min (84 codes x 2 URLs, 1/s), report written.

- [ ] **Step 7: Decision gate (owner):** the report goes to the owner. If identity-yield is 0% (probe prediction), recommend removing the meros entry from `BARCODE_SOURCES` (it only fetches 404s and wastes a door slot of the 2 used); owner decides. DO NOT remove it in this task.

- [ ] **Step 8: Commit** `feat(evidence): anti-enumeration junk guard + meros reality benchmark (owner keep-meros decision)`.

### Task 12: ASIN public-page door (owner-ratified 2026-07-15)

ASIN-shaped codes (`B0` + 8 alphanumerics) currently dead-end (vendor labels get no pattern URLs, and the fetchV2 door is gated to public barcodes). Amazon's `/dp/<ASIN>` page is the public catalog page. Bot-wall risk is real (PerimeterX): a blocked fetch must degrade gracefully to today's honest vendor-label reason. Evidence from this door is SUGGESTION-grade by construction (decideDecode never verifies non-public-barcode codes - unchanged).

**Files:**
- Modify: `src/services/fetchV2/index.ts` (door gate: allow `identifier.type === "asin"`)
- Modify: `src/services/fetchV2/engine.test.ts`
- Modify: `src/server/decode/pipeline.ts` (patternUrls dep returns the /dp/ URL for ASINs)

**Interfaces:**
- Consumes: `identifier.type` (fetchV2 `classify.ts` already returns `"asin"` for `B0...`).
- Produces: pipeline `patternUrls` returns `["https://www.amazon.com/dp/<ASIN>"]` for ASIN codes.

- [ ] **Step 1: Write the failing engine test** (in `engine.test.ts`, using the file's established fake-deps pattern):

```ts
it("A7/ASIN door: an asin identifier fetches its pattern URL and yields a suggestion-grade identity", async () => {
  // deps.patternUrls returns ["https://www.amazon.com/dp/B08XYZ1234"]
  // deps.fetchPage returns a fake dp page: <title>Producto X</title> + "ASIN B08XYZ1234" in a detail table
  // run fetchV2("B08XYZ1234", deps)
  // expect: the pattern URL was fetched; outcome is a suggestion (never verified); sourcesChecked includes the dp URL
});
it("A7/ASIN door: a bot-walled dp page (503 robot html) degrades to no identity, no crash", async () => {
  // deps.fetchPage returns status 503 / "Robot Check" html
  // expect: no product identity, outcome falls through exactly like today's vendor-label dead end
});
```

- [ ] **Step 2: Run to verify failure** (today the door is skipped for non-public-barcode identifiers, so the fetch never happens).

- [ ] **Step 3: Implement the gate** in `src/services/fetchV2/index.ts` (line ~200):

```ts
    if (deps.patternUrls && (identifier.isPublicBarcode || identifier.type === "asin")) {
```

And in `src/server/decode/pipeline.ts`, extend the `patternUrls` dep (lines ~661-665):

```ts
        patternUrls: (variants) => {
          const asin = variants.find((v) => /^B0[0-9A-Z]{8}$/.test(v.toUpperCase()));
          if (asin) return [`https://www.amazon.com/dp/${asin.toUpperCase()}`];
          const c = variants.find((v) => /^\d{12,14}$/.test(v)) ?? variants[0];
          return selectBarcodeUrls(c).slice(0, 4);
        },
```

- [ ] **Step 4: Green run**: `npx vitest run src/services/fetchV2/ src/server/decode/` - all suites. Confirm decideDecode still refuses "verified" for the ASIN case (assert `outcome`/`countBehavior` in the first test is review/suggestion, never auto-count).

- [ ] **Step 5: Commit** `feat(fetchv2): ASIN public-page door - /dp/ pattern URL, suggestion-grade, bot-wall graceful (owner-ratified)`.

### Task 12b: L2 - total ladder deadline (owner-reported 36-70s blocking decodes)

Rung timeouts exist (FetchV2 25s internal, GPT 35s abort) but NOTHING bounds the SUM (Plan D + free rungs + Go-UPC + FetchV2 + GPT sequential = worst ~75s, owner saw 36-70s browser blocks). Fix per the review: a request-scoped deadline checked BEFORE each rung starts - never aborts a rung mid-flight, never starts a new one past the deadline, and every skipped rung records an honest reason.

**Files:**
- Modify: `src/server/upc/ladder.ts` (runLadder gains an optional deadline)
- Modify: `src/server/upc/ladder.test.ts`
- Modify: `src/server/decode/pipeline.ts` (compute one deadline at computeDecode start; pass to both runLadder calls)

**Interfaces:**
- Produces: `runLadder(code, rungs, opts?: { deadlineAt?: number; now?: () => number })` - fully backward compatible (opts optional).
- Env: `DECODE_LADDER_TOTAL_MS` (default 60000) - name-only entry added to `.env.example`.

- [ ] **Step 1: Write the failing test** (in `ladder.test.ts`):

```ts
describe("L2 total ladder deadline", () => {
  const rung = (name: string, settled = false): LadderRung => ({
    name,
    run: async () => ({ settled, reason: settled ? "hit" : "miss" }),
  });
  it("skips rungs whose start time is past the deadline, with an honest reason", async () => {
    let t = 0;
    const now = () => t;
    const slowRung: LadderRung = { name: "slow", run: async () => { t += 50_000; return { settled: false, reason: "miss after 50s" }; } };
    const r = await runLadder("049000006346", [slowRung, rung("second"), rung("third")], { deadlineAt: 40_000, now });
    expect(r.settledBy).toBeUndefined();
    expect(r.reasons.map((x) => x.rung)).toEqual(["slow", "second", "third"]);
    expect(r.reasons[1].reason).toContain("ladder deadline reached");
    expect(r.reasons[2].reason).toContain("ladder deadline reached");
  });
  it("no deadline passed = identical behavior to today", async () => {
    const r = await runLadder("049000006346", [rung("a"), rung("b", true)]);
    expect(r.settledBy).toBe("b");
  });
});
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/server/upc/ladder.test.ts -t "deadline"`).

- [ ] **Step 3: Minimal implementation** in `ladder.ts`:

```ts
export async function runLadder(
  _code: string,
  rungs: LadderRung[],
  opts: { deadlineAt?: number; now?: () => number } = {},
): Promise<LadderResult> {
  const now = opts.now ?? Date.now;
  const reasons: Array<{ rung: string; reason: string }> = [];
  for (const r of rungs) {
    // L2: never START a rung past the request deadline (a running rung is never aborted here -
    // each rung owns its internal timeout). Skipped rungs record the honest reason.
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) {
      reasons.push({ rung: r.name, reason: "skipped: ladder deadline reached (DECODE_LADDER_TOTAL_MS)" });
      continue;
    }
    const outcome = await r.run();
    reasons.push({ rung: r.name, reason: outcome.reason });
    if (outcome.settled) return { settledBy: r.name, outcome, reasons };
  }
  return { reasons };
}
```

- [ ] **Step 4: Green run** on `ladder.test.ts` (all existing tests must pass unchanged - opts is optional).

- [ ] **Step 5: Pipeline wiring** - at `computeDecode` start (beside `decodeStartedAt` from Task 10):

```ts
    const ladderDeadlineAt = decodeStartedAt + intEnv(process.env.DECODE_LADDER_TOTAL_MS, 60_000);
```

Pass `{ deadlineAt: ladderDeadlineAt }` to EVERY `runLadder(...)` call in the pipeline (free run, escalation Go-UPC-only run, full paid run).

- [ ] **Step 6: Green run**: `npx vitest run src/server/` + `npm run test:golden`.

- [ ] **Step 7: Commit** `feat(ladder): L2 request-scoped total deadline - no rung starts past DECODE_LADDER_TOTAL_MS (default 60s)`.

### Task 12c: L3 in-flight same-code coalescing + L6 keyless charge gate completion

L3: two concurrent scans of the same unknown code both compute, both charge a cap slot, both can call GPT (only Go-UPC deduped today). Fix: an in-flight promise map inside `withDecodeCache` keyed by the (already canonical) cache key. L6 remainder: the TOTAL-MISS branch charges the cap before knowing whether ANY paid rung can actually run (escalation branch already gates on the Go-UPC key).

**Files:**
- Modify: `src/services/ai/decodeCache.ts` (+ its test file)
- Modify: `src/server/decode/pipeline.ts` (total-miss branch charge gate)

**Interfaces:**
- `withDecodeCache` signature unchanged. New exported test hook: `__clearInFlightForTest(): void`.

- [ ] **Step 1: Write the failing coalescing test** (in the decodeCache test file):

```ts
it("L3: concurrent calls for the same key compute ONCE and share the result", async () => {
  let computes = 0;
  const compute = async () => {
    computes++;
    await new Promise((r) => setTimeout(r, 50));
    return { name: "product" };
  };
  const isSuccess = () => true;
  const [a, b, c] = await Promise.all([
    withDecodeCache("00049000006346", isSuccess, compute),
    withDecodeCache("00049000006346", isSuccess, compute),
    withDecodeCache("00049000006346", isSuccess, compute),
  ]);
  expect(computes).toBe(1);
  expect(a.value).toEqual(b.value);
  expect(c.value).toEqual(a.value);
});
it("L3: different keys still compute independently", async () => {
  let computes = 0;
  const compute = async () => { computes++; return { ok: true }; };
  await Promise.all([
    withDecodeCache("key-a", () => true, compute),
    withDecodeCache("key-b", () => true, compute),
  ]);
  expect(computes).toBe(2);
});
it("L3: a THROWING compute clears the in-flight slot so the next call retries", async () => {
  let n = 0;
  const compute = async () => { n++; if (n === 1) throw new Error("boom"); return { ok: true }; };
  await expect(withDecodeCache("key-x", () => true, compute)).rejects.toThrow("boom");
  const r = await withDecodeCache("key-x", () => true, compute);
  expect(r.value).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run to verify failure** (computes will be 3).

- [ ] **Step 3: Implement** in `decodeCache.ts` (inside `withDecodeCache`, before compute):

```ts
const inFlight = new Map<string, Promise<{ value: unknown; cached: boolean }>>();

export function __clearInFlightForTest(): void {
  inFlight.clear();
}
```

and in `withDecodeCache`'s body, after the cache-hit check and honoring `forceRefresh` (a forced refresh must NOT join an in-flight computation):

```ts
  const key = decodeCacheKey(code);
  if (!opts?.forceRefresh) {
    const pending = inFlight.get(key);
    if (pending) {
      const shared = await pending;
      return { value: shared.value as T, cached: true };
    }
  }
  const p = (async () => {
    try {
      // ... existing compute + setDecodeCache logic, returning { value, cached: false } ...
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p as Promise<{ value: unknown; cached: boolean }>);
  return (await p) as { value: T; cached: boolean };
```

(implementer: fold the file's existing compute/isSuccess/missTtl logic inside the wrapped promise; the DailyCapExceededError thrown by compute must propagate to ALL joined waiters - that is correct behavior, one cap message for all.)

- [ ] **Step 4: Green run** on the decodeCache test file + `npx vitest run src/server/decode/`.

- [ ] **Step 5: L6 completion - write the failing charge-gate test.** In the pipeline's unit test file (if one exists with mockable deps) or as a pure extraction: extract the paid-capability check into `src/server/upc/paidWorkPossible.ts`:

```ts
import "server-only";
import { isGtinShaped, isValidCheckDigit } from "@/services/upc/gtin";

/**
 * L6: a cap slot may only be charged when at least one genuinely PAID rung can actually execute.
 * With no provider keys configured the "paid" ladder degrades to free doors (brocade, pattern
 * URLs) and honest skips - that run must not eat a slot.
 */
export function paidWorkPossible(code: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const goUpc = isGtinShaped(code) && isValidCheckDigit(code) && !!env.GO_UPC_API_KEY;
  const fetchV2Paid = !!env.BRAVE_SEARCH_API_KEY || !!env.FIRECRAWL_API_KEY;
  const gpt = !!env.OPENAI_API_KEY;
  return goUpc || fetchV2Paid || gpt;
}
```

Test (new `paidWorkPossible.test.ts`): all-keys-absent -> false; each key alone -> true; Go-UPC key with a NON-GTIN code and no other keys -> false. (Implementer: verify the exact env names the pipeline/providers read - `GO_UPC_API_KEY` confirmed; check the Brave/Firecrawl/OpenAI names in `discovery.ts` / `firecrawlProvider.ts` / `gptLadderRung.ts` and use THOSE.)

- [ ] **Step 6: Wire the gate** into the total-miss branch of pipeline.ts:

```ts
    } else if (!freeRun.outcome) {
      // TOTAL FREE MISS: cap gate then the FULL paid ladder - but only charge when paid work is
      // actually possible (L6): a keyless run is free doors + honest skips, never a slot.
      if (paidWorkPossible(code)) await chargePaidSlot();
      const paidRun = await runLadder(code, buildPaidLadderRungs(code, { runGoUpc, runFetchV2, runGpt }), { deadlineAt: ladderDeadlineAt });
      ladderRun = { settledBy: paidRun.settledBy, outcome: paidRun.outcome, reasons: [...freeRun.reasons, ...paidRun.reasons] };
    }
```

- [ ] **Step 7: Green run**: `npx vitest run src/server/ src/services/ai/` + `npm run test:golden`. Pay-once audit: exactly ONE `chargePaidSlot` call still possible per request (escalation OR total-miss, never both - assert by reading the branch structure; document in the commit body).

- [ ] **Step 8: Commit** `feat(decode): L3 in-flight same-code coalescing + L6 keyless runs never charge the cap`.

---

# PHASE 2 - HARDENING ROUND

### Task 13: B2 - corpus drift detection

Turso rows can corrupt or shrink with zero code change and zero failing test; B1 (golden gate) deliberately forces OFFLINE so it cannot see this. B2 is the live-DB counterpart, env-gated so normal unit runs skip it.

**Files:**
- Create: `src/server/tire-knowledge/corpusDrift.test.ts`
- Modify: `package.json` (script `test:corpus-drift`)

- [ ] **Step 1: Write the test** (env-gated - "failing first" here means: with Turso env present and a WRONG expected count it fails; the implementer proves the mechanism, then sets the real values):

```ts
import { describe, it, expect } from "vitest";
import { lookupByExactBarcode, getTireKnowledgeMeta, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import golden from "../../../benchmarks/golden/phase1-corpus-golden.json";

const hasTurso = !!process.env.TURSO_DATABASE_URL && !!process.env.TURSO_AUTH_TOKEN;

describe.skipIf(!hasTurso)("B2 corpus drift gate (LIVE Turso - run via npm run test:corpus-drift)", () => {
  it("meta row counts have not shrunk below the committed floor", async () => {
    const meta = await getTireKnowledgeMeta();
    expect(meta).not.toBeNull();
    // FLOOR = the generated meta's counts at plan time; shrinkage = drift. Growth is fine.
    expect(meta!.barcode_index_count ?? 0).toBeGreaterThanOrEqual(76000); // implementer: set from current meta json
  });
  it("10 spot-check golden barcodes still resolve live with the golden identity", async () => {
    __resetTireKnowledgeCacheForTests();
    const spots = (golden as Array<{ code: string; brand: string }>).slice(0, 10);
    for (const g of spots) {
      const row = await lookupByExactBarcode(g.code);
      expect(row, `${g.code} vanished from live corpus`).not.toBeNull();
      expect(row!.brand).toBe(g.brand);
    }
  });
});
```

Implementer: read `src/server/tire-knowledge/tireKnowledge.generated.meta.json` and set the real floor (round DOWN to a stable floor, e.g. current count minus 1%).

- [ ] **Step 2: Prove the mechanism**: with Turso env in `.env.local` loaded, temporarily set the floor to `999999999`, run `npx vitest run src/server/tire-knowledge/corpusDrift.test.ts` - expect FAIL; restore the real floor - expect PASS. Without env: expect SKIP.

- [ ] **Step 3: Add script** to package.json: `"test:corpus-drift": "vitest run src/server/tire-knowledge/corpusDrift.test.ts"`.

- [ ] **Step 4: Commit** `test(corpus): B2 live drift gate - row-count floor + 10 golden spot checks (env-gated)`.

### Task 14: B5 - auto-count poison battery

**Files:**
- Create: `src/stores/autoCountBattery.test.ts`

- [ ] **Step 1: Write the battery** (pure `canAutoCount` from `src/stores/scanGates.ts` - 10 adversarial cases + 2 positive controls; every rejection asserts the HONEST reason):

```ts
import { describe, it, expect } from "vitest";
import { canAutoCount } from "./scanGates";

const base = {
  codeType: "upc_a", tireOk: true, contextConflict: null, productNameUsable: true,
  decision: { status: "verified", confidence: 0.9, exactCodeEvidenceVerifiedByApp: true, corroborationPath: "app_verified" },
  productName: "Michelin Defender LTX M/S 275/60R20 115T",
};

describe("B5 auto-count adversarial battery - never count a doubtful identity", () => {
  it("control: fully verified + corroborated tire auto-counts", () => {
    expect(canAutoCount(base as any).allowed).toBe(true);
  });
  it("control: gpt self-report on a public barcode (trusted tier) auto-counts", () => {
    const d = { ...base, decision: { ...base.decision, corroborationPath: "gpt_self_report", exactCodeEvidenceVerifiedByApp: false } };
    expect(canAutoCount(d as any).allowed).toBe(true);
  });
  const rejects: Array<[string, any, string]> = [
    ["vendor label shape", { ...base, codeType: "vendor_label", decision: { ...base.decision, corroborationPath: "gpt_self_report", exactCodeEvidenceVerifiedByApp: false } }, "not app-corroborated"],
    ["confidence 0.79", { ...base, decision: { ...base.decision, confidence: 0.79 } }, "confidence below 0.8"],
    ["suggested status", { ...base, decision: { ...base.decision, status: "suggested" } }, "not app-corroborated"],
    ["missing tire specs", { ...base, tireOk: false }, "tire scan missing countable identity"],
    ["brand-prefix conflict", { ...base, contextConflict: { kind: "brand_prefix" } }, "conflict"],
    ["unusable product name", { ...base, productNameUsable: false }, "no usable product name"],
    ["no decision at all", { ...base, decision: null }, "confidence below 0.8"],
    ["verified but NOT corroborated", { ...base, decision: { ...base.decision, exactCodeEvidenceVerifiedByApp: false, corroborationPath: "single_provider" } }, "not app-corroborated"],
    ["gpt self-report on NON-public shape", { ...base, codeType: "alpha_sku", decision: { ...base.decision, corroborationPath: "gpt_self_report", exactCodeEvidenceVerifiedByApp: false } }, "not app-corroborated"],
    ["zero confidence", { ...base, decision: { ...base.decision, confidence: 0 } }, "confidence below 0.8"],
  ];
  for (const [name, input, reasonPart] of rejects) {
    it(`rejects: ${name}`, () => {
      const r = canAutoCount(input);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain(reasonPart);
    });
  }
});
```

- [ ] **Step 2: Run** `npx vitest run src/stores/autoCountBattery.test.ts` - if any case unexpectedly PASSES the gate, that is a REAL FINDING: stop, report it, do not adjust the test to green.

- [ ] **Step 3: Commit** `test(auto-count): B5 ten-case adversarial battery protects the 100% precision claim`.

### Task 15: B8 - daily-cap race hardening test

The cap has two historical bugs (double-billing L12; 232/200 counter). Storage-level atomicity is already proven (50-parallel increment test). Add the GUARD-level contract test.

**Files:**
- Modify: `src/services/security/aiSpendGuard.test.ts`

- [ ] **Step 1: Write the test**

```ts
describe("B8 daily cap race contract (guard level)", () => {
  const memStorage = () => {
    const m = new Map<string, string>();
    return {
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => void m.set(k, v),
      increment: async (k: string) => { const n = Number(m.get(k) ?? "0") + 1; m.set(k, String(n)); return n; },
    };
  };
  it("50 parallel chargeDailySlot calls bill exactly 50 (no lost increments)", async () => {
    const s = memStorage();
    await Promise.all(Array.from({ length: 50 }, () => chargeDailySlot(s, { limit: 500, dateKey: "2026-07-15" })));
    expect(await readDailyUsed(s, "2026-07-15")).toBe(50);
  });
  it("read-then-charge overshoot is bounded by caller concurrency (documented TOCTOU)", async () => {
    // limit 10, 15 concurrent callers doing the pipeline's read-check-charge dance:
    const s = memStorage();
    const limit = 10;
    let charged = 0;
    await Promise.all(Array.from({ length: 15 }, async () => {
      const used = await readDailyUsed(s, "2026-07-15");
      if (used >= limit) return;
      await chargeDailySlot(s, { limit, dateKey: "2026-07-15" });
      charged++;
    }));
    // The check-then-charge window means up to (concurrency) overshoot, never unbounded:
    expect(charged).toBeGreaterThanOrEqual(10);
    expect(charged).toBeLessThanOrEqual(15);
  });
});
```

- [ ] **Step 2: Run** - Expected: PASS (documents the accepted bounded-overshoot semantics; if the first test fails, that is a real regression - stop and report).

- [ ] **Step 3: Commit** `test(cap): B8 guard-level race contract - exact billing + bounded TOCTOU overshoot documented`.

### Task 16: B3 + B6 + B7 batch (small gates)

**Files:**
- Create: `src/eval/envGate.test.ts` (B3)
- Modify: `src/services/ai/decodeBudget.test.ts` (B6 - only if bounds not already asserted)
- Modify: `src/services/ai/tireSpecs.test.ts` (B7)

- [ ] **Step 1: B3 env gate** (`src/eval/envGate.test.ts`):

```ts
import { describe, it, expect } from "vitest";

describe("B3 env behavior gate - the unit suite runs in the environment it thinks it does", () => {
  it("IS_E2E is not set during unit runs (would silently force mock-only decode paths)", () => {
    expect(process.env.IS_E2E).toBeUndefined();
  });
  it("if Turso vars are set they are shaped like real libsql credentials", () => {
    const url = process.env.TURSO_DATABASE_URL;
    if (url) expect(url.startsWith("libsql://"), "TURSO_DATABASE_URL is not a libsql URL - stale env?").toBe(true);
  });
  it("GPT_LADDER_MODEL, if set, is non-empty and has no whitespace padding", () => {
    const m = process.env.GPT_LADDER_MODEL;
    if (m !== undefined) expect(m.trim().length, "empty GPT_LADDER_MODEL silently falls back").toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: B6 clamp bounds** - read `decodeBudget.test.ts`; if the exact bound assertions are missing, add:

```ts
it("B6: clamp bounds are exactly [5000, 8000]", () => {
  expect(clampDecodeBudgetMs(1)).toBe(5000);
  expect(clampDecodeBudgetMs(4999)).toBe(5000);
  expect(clampDecodeBudgetMs(8001)).toBe(8000);
  expect(clampDecodeBudgetMs(20000)).toBe(8000);
  expect(clampDecodeBudgetMs(undefined)).toBe(8000);
  expect(clampDecodeBudgetMs("garbage")).toBe(8000);
});
```

- [ ] **Step 3: B7 specs battery** - append to `tireSpecs.test.ts` a 15-name table test of `hasRequiredTireSpecs` + `tireSizeToken` over REAL product names pulled from `benchmarks/golden/phase1-corpus-golden.json` brands + corpus name patterns (implementer: take 15 real `specsShort`/name strings from the corpus JSON, cover metric, LT-metric, commercial 19.5, and 3 non-tire negatives).

- [ ] **Step 4: Run all three files**; commit `test(gates): B3 env assertions + B6 clamp bounds + B7 tire-specs battery (batch)`.

### Task 17: Settings decode-budget drift fix (found by scout 2026-07-15)

The server clamps decode budget to [5000, 8000] (owner cost rule 2026-06-28) but `src/app/(app)/settings/page.tsx` still offers `max={20000}`, default display 13000, and copy "between 5000 and 20000 ms" - a user setting 13000 silently gets 8000.

**Files:**
- Modify: `src/app/(app)/settings/page.tsx` (lines ~107-122)

- [ ] **Step 1:** Update the input to `max={8000}`, the fallback display value to `?? 8000`, and the copy to: "How long a live decode may run before it gives up and routes the code to Needs Review (never a partial guess). The server clamps this to between 5000 and 8000 ms."
- [ ] **Step 2:** Import the constants instead of magic numbers if the component can (client component - `decodeBudget.ts` is pure, importable): `min={DECODE_BUDGET_MIN_MS} max={DECODE_BUDGET_MAX_MS}`.
- [ ] **Step 3:** Run `npm run test:e2e` settings specs (or the full e2e if not filterable) - green.
- [ ] **Step 4:** Commit `fix(settings): decode budget UI matches the real [5000,8000] server clamp (drift found in review)`.

### Task 20: Pay-once durability - decode-cache backup/restore (owner-ratified 2026-07-15)

Gap: a Turso `decode_cache` wipe would force re-paying un-approved paid decodes (archive keeps raw data but is not a lookup rung). Decision: NO corpus write-back of AI decodes (trust firewall: the corpus is ground truth, machine guesses must never become indistinguishable from it); NO archive replay this round (duplicates decision logic, drift risk). The proportionate fix: faithful dump/restore of the decode_cache itself, hooked into the Sunday job.

**Files:**
- Create: `src/server/decodeCacheBackup.ts` (pure: `exportDecodeCache(rows) -> jsonl string`, `parseBackup(jsonl) -> PersistedDecode[]` with per-line validation, skip-corrupt-never-throw)
- Test: `src/server/decodeCacheBackup.test.ts`
- Create: `scripts/decode-cache-backup.mjs` (`--dump` reads Turso decode_cache (env) or the local file store to `backups/decode-cache-<date>.jsonl`; `--restore <file>` upserts rows back via INSERT OR IGNORE - existing rows always win, a restore can never overwrite a newer decode)
- Modify: `TESTING.md` ops note (backup file location, restore command, Sunday cron hook)

**Steps:** TDD the pure module (round-trip test: export -> parse -> deep-equal; corrupt-line test: bad JSON line skipped, valid lines survive; empty test); script smoke on the local file store (dump then restore to a temp copy, assert row parity); document; commit `feat(pay-once): decode-cache backup/restore - wipe costs a restore, never a re-pay (Task 20)`.

**Out of scope (documented triggers):** corpus write-back of HUMAN-approved identities = A1 flywheel (second tenant); archive->cache replay rung (build if a real wipe ever happens before backups existed).

### Task 21: Trusted-source confidence floor + learned-products corpus tier (owner-ratified 2026-07-15)

Owner rule: one LEGIT source (manufacturer site, Walmart, Target, Discount Tire, Tire Rack class) confirming the exact code deserves near-certain confidence; and a decode that ALSO passes an independent prefix corroboration deserves to be remembered corpus-style. Contained design - the trusted corpus stays pure; learned rows live in their own tier.

**Files:**
- Create: `src/services/ai/trustedProductHosts.ts` + test - allowlist + `isTrustedProductHost(url)` (extend/reuse EvidenceVerifier's url_only allowlist; include major retailers + tire manufacturer domains; exact-host or registrable-domain match, never substring)
- Modify: `src/services/ai/decode.ts` (or fetchV2 scoring - wherever finalConfidence lands) + test - CONFIDENCE FLOOR 0.95 applied ONLY when ALL hold: fetched_source strength, app-verified exact code, strong association, trusted host, no brand-prefix conflict. Never literal 1.0 (retail pages carry ~1-2% wrong UPCs; human override stays supreme).
- Create: `src/server/learnedProducts.ts` + test - Turso/file table `learned_products` (code PRIMARY KEY canonical, name, brand, category, specs_short, specs_full, confidence, source_url, evidence_strength, prefix_check TEXT, created_at; INSERT OR REPLACE keyed canonically). Write gate `shouldLearnDecode(...)` PURE: status verified AND exactCodeEvidenceVerifiedByApp AND strength fetched_source AND trusted host AND PREFIX POSITIVELY CORROBORATES brand (lookupPrefix dominant match OR strong tirePrefixHints family match - "no conflict" alone is NOT enough) AND (tire => hasRequiredTireSpecs).
- Modify: `src/server/decode/pipeline.ts` (serialized slot) - (a) after a verified decode, fire-and-forget `learnDecode` write when the gate passes; (b) corpus peek order: tires/retail trusted hit (unchanged, verified 0.92) -> miss -> `learned_products` hit returns SUGGESTION-grade at stored confidence (flows through the existing >=0.8 auto-apply store gate; never blanket-verified) with reason naming the learned tier + original source host.
- E2E-safe: all skipped under e2eMode(); tests mock storage.

**Steps:** TDD gate + host allowlist first (adversarial cases: category-page URL on trusted host with weak association -> NO floor/NO learn; prefix silent (no dominant) -> learn refused; sibling-size tire -> refused by specs+identity as today). Then pipeline wiring in the serialized slot AFTER Task 9. Full decode suite + golden gate green. Commit `feat(learning): trusted-source 0.95 floor + prefix-corroborated learned-products tier (Task 21)`.

**Honesty rules:** learned rows NEVER mark resolver "known" (that stays alias/verified-product only); learned tier is server-side decode assistance, suggestion-grade until a human approves once. GATE for shipping today: lands only if the final full sweep + preview re-proof stay green; else revert the single commit and demo on the proven baseline.

---

# PHASE 3 - OPS

### Task 18: DT-harvest Sunday-night schedule (owner picked Sunday)

**Files:** none in repo (Windows Task Scheduler entry on the owner machine).

- [ ] **Step 1:** Verify the job runs clean manually once: `node scripts/dt-harvest/weekly.mjs` - expect a report at `scripts/dt-harvest/state/weekly-report-<date>.md`, exit 0 (non-zero = anomalies; report them first).
- [ ] **Step 2:** Register the weekly task (PowerShell, local machine op - pre-authorized):

```powershell
schtasks /Create /TN "Scanbin-DT-Harvest-Weekly" /TR "cmd /c cd /d C:\Users\djsan\inventory && node scripts\dt-harvest\weekly.mjs >> scripts\dt-harvest\state\weekly-cron.log 2>&1" /SC WEEKLY /D SUN /ST 23:00 /F
```

- [ ] **Step 3:** Verify: `schtasks /Query /TN "Scanbin-DT-Harvest-Weekly"` shows Ready, next run = Sunday 23:00.
- [ ] **Step 4:** Document in `TESTING.md` ops section (task name, log path, how to pause: `schtasks /Change /TN ... /DISABLE`).

### Task 19: Repo housekeeping (strays)

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1:** Append to `.gitignore`:

```
# Session strays (2026-07-15): serena MCP state; deferred Polo's Point mockups stay on disk untracked
.serena/
mockups/
scripts/polish-eval-results.json
```

- [ ] **Step 2:** Verify `git status --short` no longer lists them; files remain on disk (NOTHING deleted - Polo's Point is deferred, not dropped).
- [ ] **Step 3:** Commit `chore(repo): gitignore session strays (.serena, mockups, polish-eval-results)`.

---

## Verification & Review Protocol (every task)

1. Implementer subagent: **Sonnet**, executes the task's TDD steps exactly.
2. Reviewer subagent: **Opus**, reviews the diff against this plan + the Global Constraints (spec compliance, no weakened tests, honest reasons).
3. After Phase 1 and Phase 2 complete: run the full gate set again (`npm run proof:full`, `npm run test:golden`, `npm run test:e2e`, `npm run qa:bots`) - the recall round touches scanner-facing behavior (A3 reason, ASIN rows), so the Human Bot Proof Gate applies.
4. Final report per the doctrine's full-report format, including the wallet line: "computed floor $X; true spend = provider console" for Task 3, and $0 confirmations for everything else.

## Explicitly OUT of scope (owner decisions 2026-07-15)

- A7-adjacent FNSKU resolution (impossible publicly - honesty label stands), P6 GS1 paid source (cut), B4 provider fixtures (cut).
- A1 flywheel (trigger: second tenant), A5 case-pack (trigger: non-tire customer), A2 photo review (post-launch), Playwright rendered-fetch door (trigger: A4 ledger data), T9 paid backfill (self-heals free), P3 prefix skew (harvest closes it), Polo's Point UI (deferred).
- L7 observability: mostly covered by A4's ledger (durationMs + reasons); per-rung latency stamps stay backlog.
- L8 parallel free rungs: LOW; A6 steering removes the tire-path cost; revisit with A4 ledger data.
- Production promote: NOT authorized by this plan.
