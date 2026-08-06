# Diagnostic Fixes and PR Salvage Implementation Plan (2026-08-04)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect surfaced by the 2026-08-04 five-agent diagnostic (sanitizer destroying 10-digit scan codes, dishonest trusted-exact miss reasons, silently swallowed corpus-load failures, opaque preview status) and resolve the uncommitted `retailtursodatabase` working tree, with parallel lower-tier subagents and batched gates.

**Architecture:** Two independent lanes. Lane A operates in the main repo (`c:\Users\djsan\inventory`) and only performs git salvage of the uncommitted PR work (no code edits). Lane B operates in a fresh git worktree branched from `codex/boss-barcode-fastpath-safe` @ `5038de82` (the active committed line serving the boss preview) and lands four TDD code fixes plus one prep script. Gates run batched at the end (Lane C), followed by a slim ultra review.

**Tech Stack:** Next.js 16 App Router route handlers, Vitest (unit project, node env), TypeScript, git worktrees. No new dependencies.

## Global Constraints

- Barcodes and part numbers are TEXT always, never numeric types (leading zeros must survive).
- TOP-LEVEL LAW: nothing in this plan may make a scanned row fail to appear or fail to count; identity gates decide labels only.
- Cost-ordered decode ladder stays intact: first settled rung stops it; free rungs before paid; `GEMINI_DECODE_DISABLED = true` stays.
- API keys stay server-side only; never log secret values; `.env*` stays gitignored.
- Automated tests NEVER call live providers (unit mocks engines/fetch; `IS_E2E=1` forces mock-only).
- No em dash or en dash in user-facing copy. Normal punctuation.
- Services stay pure (no React / next/* imports in `src/services`).
- NO git push, NO deploy, NO paid/live API calls, NO production Firebase/Turso writes anywhere in this plan. Commits are local only.
- Out of scope by owner order (2026-08-04): making non-GTIN codes resolvable. The codes 3220017199-3220017212 and 3220017314-3220017317 (and the four 10-digit codes from the diagnostic) are known non-barcodes; do NOT build lookup support for them. The sanitizer fix below is about not DESTROYING such codes in transit, not about resolving them.
- Executor tiering (owner order): Codex (gpt-5.5 medium, ChatGPT subscription) and Sonnet subagents execute; the orchestrator (this session) adjudicates, gates, and commits. No Fable subagents.
- OWNER RULE (2026-08-05, authorized): a code not found in the trusted index/corpus MUST continue through the decode ladder in EVERY environment (local, preview, prod). Probes are never a dead end. The ladder's own gates still decide rung availability (free corpus rungs run keyless; paid rungs keep keys/daily-cap/breaker/mock-default gating - this rule authorizes continuation, NOT live paid spend in dev). Implemented by Task 9.

## Execution Map (parallel lanes)

| Lane | Tasks | Executor | Serialization reason |
|---|---|---|---|
| A (main repo) | Task 1 | Orchestrator (git only) | independent of Lane B |
| B1 (worktree) | Task 2 then Task 3 then Task 5 | Codex (2,3), Sonnet (5) | all three touch `src/app/api/ai-lookup/route.ts` |
| B2 (worktree) | Task 4 | Sonnet | different files, parallel with B1 |
| B3 (worktree) | Task 6 | Sonnet | new files only, parallel with B1/B2 |
| B4 (worktree) | Task 9 | Codex | touches the scanStore monolith; gets a dedicated model review in Task 7 Step 6 |
| C (worktree) | Task 7 gates, then Task 8 docs | Orchestrator + Sonnet | after B lanes complete |

Worktree setup (fold into the first Lane B task that starts): from `c:\Users\djsan\inventory` run `git fetch origin codex/boss-barcode-fastpath-safe` then `git worktree add C:\tmp\scanbin-fix-diagnostic -b fix/decode-diagnostic-2026-08-04 origin/codex/boss-barcode-fastpath-safe`. All Lane B file paths below are relative to that worktree root.

**Fleet structure (owner order 2026-08-05: maximum sustained parallelism, ~30 concurrent target).** Execution runs as refilling waves, not one-agent-per-task. Wave 1 launches together: the 4 parallel executors (Tasks 2, 4, 6, 9), anchor-verification scouts (one per executing task, verifying quoted line anchors and harness conventions against the live worktree and feeding corrections to executors), regression-map scouts (enumerate every existing suite each task can break), and independent draft agents for Task 8's checkpoint/lessons text. As each executor finishes, a per-diff review panel fires immediately (silent-failure hunter, project-law compliance reviewer, type/test-quality reviewer - three agents per completed task) while the freed slot refills with the next serialized task (3 after 2, 5 after 3) and gate-runner agents (focused vitest, ledger, lint, Argus). Same-file tasks stay serialized (route.ts chain 2 then 3 then 5) - that is a hard correctness constraint, and the fleet keeps concurrency high by running scouts, reviewers, doc drafters, and gate runners alongside instead of padding with idle agents. Models: Sonnet/Haiku for scouts, reviewers, drafts, and gate runners; Codex for Tasks 2, 3, 9 and the diff reviews; no Fable subagents.

> Anchor note: every `file:line` reference in Lane B tasks is against branch `codex/boss-barcode-fastpath-safe` @ `5038de82` (inspectable today at `C:\tmp\scanbin-boss-fastpath-safe`), NOT against the main repo's `retailtursodatabase` working tree. Argus flagging these anchors as "files not present" is its known false-positive class for cross-branch anchors.

## Affected Files (summary)

- Lane A (main repo, git only): the ~117 uncommitted paths on `retailtursodatabase` (thematic commits, no content edits).
- Lane B (worktree): `src/app/api/ai-lookup/route.ts`, `src/server/tire-knowledge/tireKnowledgeIndex.ts`, `src/app/api/health/route.ts`, `src/stores/scanStore.ts` (Task 9, owner rule), `docs/COMMANDS.md`, new tests `route.bareCode.test.ts`, `route.trustedExactReason.test.ts`, `route.statusTrustedExact.test.ts`, `tireKnowledgeIndex.jsonStatus.test.ts`, `scanStore.ladderContinuation.test.ts`, new script pair `scripts/boss-workbook-reconcile-dryrun.mjs(.test.mjs)`.
- Lane C (main repo docs): `PROGRESS.md`, `LESSONS_LEARNED.md`, `TESTING.md`.

## Out of Scope

- Making non-GTIN codes resolvable (owner order 2026-08-04; the 32200171xx/32200173xx codes are known non-barcodes).
- The live Turso upsert/import of the corrected boss workbook (owner-gated; Task 6 only builds the offline gate).
- Merging `retailtursodatabase` into or across `codex/boss-barcode-fastpath-safe` (merge order is a separate owner decision; Task 1 Step 4 only records the facts).
- Any push, deploy, production promote, or paid/live provider call.
- UI redesign of Needs Review or the scan feed (reason text flows through existing UI unchanged).

## Risks

- R1: The Task 2 passthrough sends a bare 10-digit run to provider-facing fields; if a user typed a real bare phone number into the scan input it would reach providers as a lookup code. Mitigation: only separator-free 8-14 digit runs pass; formatted phones stay masked; the scan field is a technical identifier per GUARDRAILS ("only technical product fields reach AI"); regression test locks free-text masking.
- R2: Task 1 thematic path groups could miss or double-assign files among ~117 paths. Mitigation: Step 3 requires `git status --short` to be clean for tracked modifications; Codex plan review verifies group coverage before execution.
- R3: Route tests that mutate `process.env` can interfere under parallel vitest. Mitigation: tests delete/restore the var inline; if flake appears, mark the file `describe.sequential` and re-run.
- R4: Updating the scanStore trustedExact assertion (Task 3 Step 4) could mask a real behavior change. Mitigation: only the reason TEXT for the not-allowlisted case may change; any other assertion change is a stop-and-review.
- R5: Salvage commits land before the Codex salvage verdict if reviews stall. Mitigation: Task 1 Step 1 is a hard gate; no commits without adjudication.

## Rollback

- Lane B is a dedicated worktree branch (`fix/decode-diagnostic-2026-08-04`); rollback = delete the worktree and branch (`git worktree remove C:\tmp\scanbin-fix-diagnostic; git branch -D fix/decode-diagnostic-2026-08-04`). Nothing else references it until the owner merges.
- Lane A commits are local thematic commits on `retailtursodatabase`; rollback = `git reset --mixed <pre-salvage-HEAD>` restores the exact uncommitted state (record the starting HEAD hash in PROGRESS.md before Step 2). Never force-push (nothing is pushed).
- Docs commits (Task 8) revert with `git revert`.

## Cost

- All execution is local plus subscription-billed agents: Codex tasks on the ChatGPT subscription (Lane 1, OAuth), Sonnet subagents on the Claude subscription. Zero paid API keys involved; no live provider calls; Turso is not touched. Argus and all gates are $0 shell runs.

---

### Task 1: Salvage-commit the retailtursodatabase working tree (Lane A, decision-gated)

**Files:**
- Modify: nothing by hand. Git operations only, in `c:\Users\djsan\inventory`.

**Interfaces:**
- Consumes: the Codex salvage review verdict (job task-msfkkdlm-ch04v7) and the Gemini review (verdict: keep all five themes).
- Produces: the working tree committed to branch `retailtursodatabase` as thematic commits (or explicitly archived if Codex finds Critical defects the orchestrator upholds).

- [ ] **Step 1: Adjudicate the two salvage reviews.** If Codex reports no Critical defect the orchestrator upholds, proceed to Step 2. If a Critical is upheld in a theme, exclude that theme's files from Step 2 and record the exclusion in PROGRESS.md.
- [ ] **Step 2: Commit in five thematic commits** (theme membership from the Gemini review; adjust per Step 1):

```bash
cd c:\Users\djsan\inventory
git add src/server/tire-knowledge/ src/server/decode/pipeline.ts src/server/decode/pipeline.test.ts
git commit -m "feat(salvage): sharded exact-index lookup rung (retail-turso draft, theme A)"
git add src/app/api/ai-lookup/
git commit -m "feat(salvage): tenant-scoped auth caching and rate limiting (theme B)"
git add src/stores/ src/services/db/ src/services/mockDb.ts src/services/mockDb.test.ts src/services/security/sensitiveFields.ts
git commit -m "feat(salvage): transactional sync and dependency-aware drain queue (theme C)"
git add src/components/
git commit -m "feat(salvage): live feed render window and decoding badges (theme D)"
git add scripts/ data/ next.config.ts package.json docs/COMMANDS.md PROGRESS.md src/server/retail-knowledge/ src/server/upc/
git commit -m "feat(salvage): staged atomic corpus build pipelines (theme E)"
git status --short
```

- [ ] **Step 3: Verify clean tree.** `git status --short` must show no modified tracked files (untracked leftovers are listed in the Task 8 checkpoint). Do NOT push.
- [ ] **Step 4: Record overlap facts for the future merge** (no action now): the boss branch carries exact-index manifest schemaVersion 2.0.0 with 84,464 keys; this branch carries 1.0.0 with 80,227 keys. Write one line to PROGRESS.md stating that `codex/boss-barcode-fastpath-safe` supersedes theme A's index artifacts and any future merge takes the v2 shards.

### Task 2: Bare-numeric scan codes must survive sanitization into the decode pipeline (Lane B1, Codex)

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts:347-388` (the request-shaping block quoted below)
- Test: `src/app/api/ai-lookup/route.bareCode.test.ts` (create)

**Interfaces:**
- Consumes: existing `cleanScanCode` (from `@/services/scanCleaner`), `sanitizeForAiLookup` (from `@/services/sanitizer`), existing test-harness conventions from `src/app/api/ai-lookup/route.d4.test.ts` (mirror its mock setup for `runDecodePipeline` and request building; keep the assertions below verbatim).
- Produces: route-level guarantee used by Tasks 3 and 5: `code`, `req.rawCodeSanitized`, and `req.cleanCodeSanitized` all equal the unmasked scan code whenever the scanned identifier is one bare digit run of 8 to 14 digits.

- [ ] **Step 1: Write the failing test** (`route.bareCode.test.ts`):

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const runDecodePipeline = vi.fn();
vi.mock("@/server/decode/pipeline", () => ({
  runDecodePipeline: (...args: unknown[]) => runDecodePipeline(...args),
}));

// Mirror route.d4.test.ts for any additional module mocks the route needs at import time.
import { POST } from "./route";

function decodeRequest(cleanCode: string) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "decode", cleanCode, rawCode: cleanCode }),
  });
}

describe("bare numeric scan codes reach the pipeline unmasked", () => {
  beforeEach(() => {
    runDecodePipeline.mockReset();
    runDecodePipeline.mockResolvedValue({
      mode: "decode", providerNames: [], results: [],
      decision: { status: "needs_review", confidence: 0, reason: "test", evidenceStrength: "none", exactCodeEvidenceVerifiedByApp: false, crossCheck: { decision: "not_checked", confidence: 0, reason: "test", brandSimilarity: 0, nameSimilarity: 0, contradictions: [] } },
      timedOut: false,
    });
  });

  it("passes a bare 10-digit code through un-redacted", async () => {
    await POST(decodeRequest("3220015959"));
    expect(runDecodePipeline).toHaveBeenCalled();
    const flat = JSON.stringify(runDecodePipeline.mock.calls[0]);
    expect(flat).toContain("3220015959");
    expect(flat).not.toContain("redacted-phone");
  });

  it("still sanitizes free text with a formatted phone number", async () => {
    await POST(decodeRequest("call (305) 555-1234 about tire"));
    const flat = JSON.stringify(runDecodePipeline.mock.calls[0]);
    expect(flat).toContain("redacted-phone");
    expect(flat).not.toContain("305");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/app/api/ai-lookup/route.bareCode.test.ts` from the worktree root. Expected: first test FAILS with `[redacted-phone]` found in the pipeline call (second test may already pass).
- [ ] **Step 3: Implement the minimal fix.** In `route.ts`, immediately after the existing lines that compute `exactCode`, `rawCodeSanitized`, `cleanCodeSanitized` (currently lines 350-354), replace the single line `const code = cleanCodeSanitized || rawCodeSanitized;` with:

```ts
  // A scanned identifier that is one bare digit run of 8 to 14 digits is a lookup code, not free
  // text. The phone sanitizer masks bare 10-digit runs, which made every downstream rung search
  // for the literal string "[redacted-phone]" instead of the real code. Formatted phone numbers
  // (separators, letters, extra words) never match this shape and stay masked.
  const bareNumericCode = /^\d{8,14}$/.test(exactCode) ? exactCode : null;
  const code = bareNumericCode ?? (cleanCodeSanitized || rawCodeSanitized);
```

  and where `req` is built (currently lines 381-388), change the two fields to:

```ts
    rawCodeSanitized: bareNumericCode ?? rawCodeSanitized,
    cleanCodeSanitized: bareNumericCode ?? cleanCodeSanitized,
```

- [ ] **Step 4: Run the new test and the existing route suites.** Run: `npx vitest run src/app/api/ai-lookup/` Expected: ALL PASS (route.a2 / route.d4 / route.masterAppend / trustedExact suites must not regress).
- [ ] **Step 5: Commit.**

```bash
git add src/app/api/ai-lookup/route.ts src/app/api/ai-lookup/route.bareCode.test.ts
git commit -m "fix(decode): bare numeric scan codes survive sanitization into the pipeline"
```

### Task 3: Honest deterministic-miss reasons (Lane B1, Codex, after Task 2)

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts:456-466` (the fall-through and deterministicOnly block quoted in Step 3)
- Test: `src/app/api/ai-lookup/route.trustedExactReason.test.ts` (create)

**Interfaces:**
- Consumes: `deterministicMissBody(reasonCode, reason)` exactly as defined at route.ts:61; `trustedBossAccess` boolean from route.ts:396-398; Task 2's request-shaping changes.
- Produces: reasonCodes consumed by the client and Task 5's status field: `trusted_exact_not_available` (session not allowlisted, nothing was checked) and `trusted_exact_miss` (allowlisted session, code genuinely absent from the trusted index). Reason texts below are user-facing copy; no em or en dashes.

- [ ] **Step 1: Write the failing test** (`route.trustedExactReason.test.ts`, same harness conventions as Task 2's test):

```ts
import { describe, expect, it } from "vitest";
// Mirror route.d4.test.ts module mocks. No pipeline mock needed: deterministicOnly must never reach it.
import { POST } from "./route";

function probe(cleanCode: string) {
  return new Request("http://localhost/api/ai-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "decode", cleanCode, rawCode: cleanCode, deterministicOnly: true }),
  });
}

describe("deterministicOnly miss reasons are honest", () => {
  it("tells a non-allowlisted session that nothing was checked", async () => {
    // Default test env: TRUSTED_EXACT_BOSS_BUSINESS_IDS unset, mock auth.
    const res = await POST(probe("8848116004503"));
    const body = await res.json();
    expect(body.reasonCode).toBe("trusted_exact_not_available");
    expect(body.reasonText).toBe("Trusted exact lookup is not enabled for this session, so the code was not checked against the trusted index.");
    expect(body.decision.status).toBe("needs_review");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/app/api/ai-lookup/route.trustedExactReason.test.ts` Expected: FAIL, reasonCode is `no_result`.
- [ ] **Step 3: Implement.** Replace the current block (route.ts:462-466):

```ts
  // Deterministic-only is a work-reduction request. A non-allowlisted member, a mock caller, or an
  // allowlisted exact miss exits here without reaching storage, catalog, legacy, or provider code.
  if (isDecodeMode && body.deterministicOnly === true) {
    return Response.json(deterministicMissBody());
  }
```

  with:

```ts
  // Deterministic-only is a work-reduction request. A non-allowlisted member, a mock caller, or an
  // allowlisted exact miss exits here without reaching storage, catalog, legacy, or provider code.
  // The reason must be honest: only an allowlisted session actually consulted the trusted index.
  if (isDecodeMode && body.deterministicOnly === true) {
    if (!trustedBossAccess) {
      return Response.json(
        deterministicMissBody(
          "trusted_exact_not_available",
          "Trusted exact lookup is not enabled for this session, so the code was not checked against the trusted index.",
        ),
      );
    }
    return Response.json(deterministicMissBody("trusted_exact_miss"));
  }
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/app/api/ai-lookup/ src/stores/scanStore.trustedExact.test.ts` Expected: ALL PASS. If `scanStore.trustedExact.test.ts` asserts the old generic reason for the not-allowlisted case, update that assertion to the new text (the store displays `decision.reason` verbatim; its fallback literal at scanStore.ts:3739/3743 stays unchanged).
- [ ] **Step 5: Commit.**

```bash
git add src/app/api/ai-lookup/route.ts src/app/api/ai-lookup/route.trustedExactReason.test.ts
git commit -m "fix(decode): honest reason codes for deterministic-only trusted exact misses"
```

### Task 4: Surface tire JSON index load state instead of silent forever-miss (Lane B2, Sonnet)

**Files:**
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts:51-70`
- Modify: `src/app/api/health/route.ts` (add one field to the existing JSON)
- Test: `src/server/tire-knowledge/tireKnowledgeIndex.jsonStatus.test.ts` (create)

**Interfaces:**
- Consumes: existing `getJsonIndex()` singleton behavior (tireKnowledgeIndex.ts:56-70) and the existing health route response object.
- Produces: `export function tireJsonIndexStatus(): { state: "not_loaded" | "loaded" | "failed"; barcodeRows: number; message: string | null }` consumed by the health route (field name `tireJsonIndex`).

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, expect, it } from "vitest";
import { tireJsonIndexStatus } from "./tireKnowledgeIndex";

describe("tireJsonIndexStatus", () => {
  it("reports not_loaded before any lookup and never throws", () => {
    const s = tireJsonIndexStatus();
    expect(["not_loaded", "loaded", "failed"]).toContain(s.state);
    expect(typeof s.barcodeRows).toBe("number");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/server/tire-knowledge/tireKnowledgeIndex.jsonStatus.test.ts` Expected: FAIL with "tireJsonIndexStatus is not a function" (export missing).
- [ ] **Step 3: Implement.** In `tireKnowledgeIndex.ts`, add module state `let _jsonIndexError: string | null = null;` next to `_jsonIndex` (line 51), set `_jsonIndexError = (e as Error).message;` inside the existing catch (line 65-68), and append at module scope:

```ts
/** Operational visibility: the JSON fallback swallows load failures into a process-lifetime miss.
 *  This status lets /api/health surface that state instead of decoding silently returning nothing. */
export function tireJsonIndexStatus(): { state: "not_loaded" | "loaded" | "failed"; barcodeRows: number; message: string | null } {
  if (_jsonIndex === "missing") return { state: "failed", barcodeRows: 0, message: _jsonIndexError };
  if (_jsonIndex) return { state: "loaded", barcodeRows: Object.keys(_jsonIndex.barcodeIndex).length, message: null };
  return { state: "not_loaded", barcodeRows: 0, message: null };
}
```

  In the health route, import it (`import { tireJsonIndexStatus } from "@/server/tire-knowledge/tireKnowledgeIndex";`) and add `tireJsonIndex: tireJsonIndexStatus(),` to the response object.
- [ ] **Step 4: Run tests.** Run: `npx vitest run src/server/tire-knowledge/` Expected: ALL PASS (existing tireKnowledge suites must not regress).
- [ ] **Step 5: Commit.**

```bash
git add src/server/tire-knowledge/tireKnowledgeIndex.ts src/server/tire-knowledge/tireKnowledgeIndex.jsonStatus.test.ts src/app/api/health/route.ts
git commit -m "feat(health): surface tire JSON index load state instead of silent forever-miss"
```

### Task 5: Trusted-exact configuration visibility on the status GET (Lane B1, Sonnet, after Task 3)

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts:165-272` (the existing GET handler's response object)
- Modify: `docs/COMMANDS.md` (the port table row for 3400)
- Test: `src/app/api/ai-lookup/route.statusTrustedExact.test.ts` (create)

**Interfaces:**
- Consumes: `trustedBossBusinessIds()` (route.ts:52-59); the existing GET handler response shape.
- Produces: GET response field `trustedExact: { allowlistConfigured: boolean }`. Never include the allowlist VALUES (business ids are tenant data).

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, expect, it } from "vitest";
// Mirror route.d4.test.ts module mocks.
import { GET } from "./route";

describe("status GET exposes trusted exact configuration", () => {
  it("reports allowlistConfigured=false when the env allowlist is unset", async () => {
    delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
    const res = await GET(new Request("http://localhost/api/ai-lookup"));
    const body = await res.json();
    expect(body.trustedExact).toEqual({ allowlistConfigured: false });
  });

  it("reports allowlistConfigured=true when set, without leaking ids", async () => {
    process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS = "some-biz-id";
    const res = await GET(new Request("http://localhost/api/ai-lookup"));
    const body = await res.json();
    expect(body.trustedExact).toEqual({ allowlistConfigured: true });
    expect(JSON.stringify(body)).not.toContain("some-biz-id");
    delete process.env.TRUSTED_EXACT_BOSS_BUSINESS_IDS;
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/app/api/ai-lookup/route.statusTrustedExact.test.ts` Expected: FAIL, `trustedExact` undefined.
- [ ] **Step 3: Implement.** In the GET handler's returned JSON object add:

```ts
    trustedExact: { allowlistConfigured: trustedBossBusinessIds().size > 0 },
```

- [ ] **Step 4: Update docs.** In `docs/COMMANDS.md`, change the port 3400 row description to: `Fable 5 measured personas, preview stress runs, and the boss corpus certification harness (e2e/boss-barcode-corpus/production-server.mjs). The harness serves a synthetic allowlist; real accounts always get trusted-exact misses here by design.`
- [ ] **Step 5: Run tests, then commit.** Run: `npx vitest run src/app/api/ai-lookup/` Expected: ALL PASS.

```bash
git add src/app/api/ai-lookup/route.ts src/app/api/ai-lookup/route.statusTrustedExact.test.ts docs/COMMANDS.md
git commit -m "feat(status): expose trusted exact allowlist configuration on the status GET"
```

### Task 6: Boss workbook reconciliation dry-run script (Lane B3, Sonnet)

**Files:**
- Create: `scripts/boss-workbook-reconcile-dryrun.mjs`
- Create: `scripts/boss-workbook-reconcile-dryrun.test.mjs` (node:test, like `npm run teach:test` style plain suites)
- Test fixture: inline in the test file (no repo data files)

**Interfaces:**
- Consumes: a CSV path argument with headers `barcode,part_number,brand,model,size` (the corrected boss workbook exported to CSV).
- Produces: JSON to stdout: `{ accepted: Row[], needsReview: Row[], blanks: Row[] }` where accepted rows have a GTIN-shaped barcode (8, 12, 13, or 14 digits) with a valid GS1 check digit. NO database access of any kind; this is the pre-import gate the owner runs when the corrected workbook arrives. The live upsert itself stays owner-gated and is NOT part of this plan.

- [ ] **Step 1: Write the failing test** (`scripts/boss-workbook-reconcile-dryrun.test.mjs`):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRows, gs1CheckDigitValid } from "./boss-workbook-reconcile-dryrun.mjs";

test("valid EAN-13 is accepted", () => {
  const out = classifyRows([{ barcode: "8848116004503", part_number: "BH1600450", brand: "Blackhawk", model: "", size: "" }]);
  assert.equal(out.accepted.length, 1);
});

test("10-digit code goes to needsReview, blank goes to blanks", () => {
  const out = classifyRows([
    { barcode: "3220015959", part_number: "BH1600448", brand: "Blackhawk", model: "", size: "" },
    { barcode: "", part_number: "BH1600449", brand: "Blackhawk", model: "", size: "" },
  ]);
  assert.equal(out.needsReview.length, 1);
  assert.equal(out.blanks.length, 1);
});

test("check digit is enforced, not just shape", () => {
  assert.equal(gs1CheckDigitValid("8848116004503"), true);
  assert.equal(gs1CheckDigitValid("8848116004504"), false);
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `node --test scripts/boss-workbook-reconcile-dryrun.test.mjs` Expected: FAIL, module not found.
- [ ] **Step 3: Implement** (`scripts/boss-workbook-reconcile-dryrun.mjs`):

```js
#!/usr/bin/env node
// Pre-import gate for the corrected boss workbook (CSV export). Classifies rows; NEVER touches a DB.
// Usage: node scripts/boss-workbook-reconcile-dryrun.mjs path/to/workbook.csv
import { readFileSync } from "node:fs";

export function gs1CheckDigitValid(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function classifyRows(rows) {
  const accepted = [], needsReview = [], blanks = [];
  for (const row of rows) {
    const barcode = String(row.barcode ?? "").trim();
    if (!barcode) blanks.push(row);
    else if (gs1CheckDigitValid(barcode)) accepted.push(row);
    else needsReview.push(row);
  }
  return { accepted, needsReview, blanks };
}

function parseCsv(text) {
  const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = header.split(",").map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim()]));
  });
}

const csvPath = process.argv[2];
if (csvPath) {
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const out = classifyRows(rows);
  console.log(JSON.stringify({ counts: { accepted: out.accepted.length, needsReview: out.needsReview.length, blanks: out.blanks.length }, ...out }, null, 2));
}
```

- [ ] **Step 4: Run the test.** Run: `node --test scripts/boss-workbook-reconcile-dryrun.test.mjs` Expected: PASS (3 tests).
- [ ] **Step 5: Commit.**

```bash
git add scripts/boss-workbook-reconcile-dryrun.mjs scripts/boss-workbook-reconcile-dryrun.test.mjs
git commit -m "feat(boss): reconciliation dry-run gate for the corrected boss workbook"
```

### Task 9: Ladder continuation after every trusted-exact miss (Lane B4, Codex; OWNER RULE 2026-08-05)

**Files:**
- Modify: `src/stores/scanStore.ts:3718-3762` (the deterministicOnly miss block quoted below; anchor is boss-branch-relative)
- Test: `src/stores/scanStore.ladderContinuation.test.ts` (create, dom project; mirror harness conventions from `src/stores/scanStore.trustedExact.test.ts`)

**Interfaces:**
- Consumes: `evaluateAutoDecode({ aiEnabled, status, online, dailyCount, dailyLimit, breaker, now })` exactly as already called at scanStore.ts:3726-3734; `materializeTrustedExactMiss(reviewId, reason)`; `get().liveDecode(id, { invalidationGeneration })`.
- Produces: the owner-rule behavior every environment relies on: ANY deterministicOnly miss continues into the full ladder request unless online/emergency-stop/breaker/aiLookupEnabled block it; GTIN shape and misread-likelihood NEVER suppress continuation; when continuation is blocked the row's reason states both the miss and why decode did not continue.

- [ ] **Step 1: Write the failing test** (`scanStore.ladderContinuation.test.ts`): mirror the trustedExact test harness (store setup, fetch mock, probe flow). Assert, using a 10-digit code (e.g. "3220015959"):

```ts
// Case 1: probe miss on a NON-GTIN code -> a follow-up POST to /api/ai-lookup WITHOUT
// deterministicOnly:true must fire (the old code required canonicalGtin(cleanCode) !== null,
// which dead-ended every non-GTIN code). Assert the fetch mock received the follow-up call
// and the review row's decodeStatus went through "decoding".
// Case 2: same probe miss while offline (store.online = false) -> NO follow-up call, and the
// review row's reason contains both the miss and the words explaining decode did not continue.
// Case 3 (TOP-LEVEL LAW guard): in both cases the scanFeed row exists and session totals are
// unchanged by the miss handling (counting happened at scan time and stays intact).
```

  Write the three cases as real executable tests in the harness's idiom; the assertions above are the required behavior, verbatim test code follows the conventions of `scanStore.trustedExact.test.ts` (same mocks, same store bootstrap).
- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/stores/scanStore.ladderContinuation.test.ts` Expected: Case 1 FAILS (no follow-up call for a non-GTIN code).
- [ ] **Step 3: Implement.** In the deterministicOnly block, delete the `shouldFallbackToOrdinary` computation (currently `ordinaryGate.allowed && canonicalGtin(review.cleanCode) !== null && !isLikelyMisreadGtin(review.cleanCode)`) and replace the branching with:

```ts
            // OWNER RULE (2026-08-05): a trusted-exact miss is never a dead end. The code continues
            // into the ordinary ladder in EVERY environment; the ladder's own server-side gates
            // decide which rungs run. dailyCount is passed as 0 here on purpose: the daily cap
            // charges paid rungs server-side, and free corpus rungs must still run at the cap.
            // GTIN shape and misread-likelihood inform identity downstream; they never suppress
            // the continuation itself.
            const continuationGate = evaluateAutoDecode({
              aiEnabled: currentSettings.aiLookupEnabled,
              status: current.aiStatus,
              online: current.online,
              dailyCount: 0,
              dailyLimit: currentSettings.dailyLookupLimit,
              breaker: current.breaker,
              now: currentNow,
            });
            if (continuationGate.allowed) {
              const persisted = materializeTrustedExactMiss(reviewId, decision?.reason || "No trusted exact match was found.");
              if (persisted) void get().liveDecode(persisted.id, { invalidationGeneration });
              return;
            }
```

  Keep the existing not-continued branch (probe cleanup plus the scanFeed/needsReviewQueue needs_review update) but extend `missReason` to state why decode did not continue, using the gate's own reason when `evaluateAutoDecode` exposes one (check its return type in `src/stores/autoDecode`), else a mapped text such as "Decode did not continue: offline." No em or en dashes in these strings. Remove `canonicalGtin`/`isLikelyMisreadGtin` from this block and drop their imports if now unused elsewhere in the file.
- [ ] **Step 4: Run the store suites.** Run: `npx vitest run src/stores/scanStore.ladderContinuation.test.ts src/stores/scanStore.trustedExact.test.ts src/stores/autoDecode.test.ts` Expected: ALL PASS. If `scanStore.trustedExact.test.ts` asserted the old GTIN-gated dead end, update those assertions to the owner rule and note it in the commit body.
- [ ] **Step 5: Run the ledger gate** (scanStore touched): `npm run test:ledger` Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add src/stores/scanStore.ts src/stores/scanStore.ladderContinuation.test.ts src/stores/scanStore.trustedExact.test.ts
git commit -m "feat(decode): owner rule, trusted-exact misses always continue into the ladder"
```

### Task 7: Batched gates (Lane C, orchestrator)

**Files:** none modified. Commands from the Lane B worktree root.

- [ ] **Step 1:** `npx vitest run src/app/api/ai-lookup/ src/server/tire-knowledge/ src/stores/scanStore.trustedExact.test.ts src/stores/scanStore.ladderContinuation.test.ts src/stores/autoDecode.test.ts` Expected: ALL PASS.
- [ ] **Step 2:** `node --test scripts/boss-workbook-reconcile-dryrun.test.mjs` Expected: PASS.
- [ ] **Step 3:** `npm run proof:local` (tsc + unit projects). Expected: exit 0. Task 9 touches scanStore, so `npm run test:ledger` is REQUIRED (also run inside Task 9 Step 5; re-run here as the batched gate).
- [ ] **Step 4:** `npx eslint src/app/api/ai-lookup src/server/tire-knowledge scripts/boss-workbook-reconcile-dryrun.mjs` Expected: clean (repo-wide `npm run lint` has known unrelated noise; report separately if hit).
- [ ] **Step 5:** `python -m tools.fable5 review-build` (Argus, deterministic, $0). Adjudicate findings; fix root causes, never weaken tests.
- [ ] **Step 6: Slim ultra review.** One Codex diff review of `git diff origin/codex/boss-barcode-fastpath-safe...HEAD` in the worktree plus one Sonnet silent-failure pass over the same diff. Fix any upheld Critical/Important with a failing-first test before closing.

### Task 8: Checkpoint and lessons (Lane C, Sonnet)

**Files:**
- Modify: `PROGRESS.md` (main repo)
- Modify: `LESSONS_LEARNED.md` (main repo)
- Modify: `TESTING.md` (main repo)

- [ ] **Step 1:** Append a dated PROGRESS.md checkpoint: diagnostic verdict summary (certification harness vs real session; 4 codes never promoted; sanitizer class bug), Task 1 salvage commit hashes, fix branch name `fix/decode-diagnostic-2026-08-04` and its commit hashes, exact-index v1/v2 supersession note, and the explicit next steps (owner: corrected workbook; owner-gated: merge order and any push).
- [ ] **Step 2:** Append LESSONS_LEARNED entry L14: "The AI-lookup sanitizer masked bare 10-digit scan codes into [redacted-phone] before every lookup rung. Class rule: the scanned code field is a technical identifier; sanitize free text, never the lookup key. Regression: route.bareCode.test.ts." And L15: "A localhost preview answered honest-looking misses because it was the certification harness with a synthetic allowlist. Class rule: status endpoints must expose which trust mode is active; never manually test trust-gated flows on a harness instance."
- [ ] **Step 3:** Add the new test files to TESTING.md's coverage map with one-line purposes.
- [ ] **Step 3b:** Record the owner rule in CLAUDE.md's decode section (one bullet): "Owner rule (2026-08-05): a code not found in the trusted index/corpus MUST continue through the decode ladder in every environment (local, preview, prod). Probes never dead-end; the ladder's own gates decide rung availability and skipped rungs surface honest reasons." Add the matching one-liner to GUARDRAILS.md's Decode discipline section.
- [ ] **Step 4:** Commit docs in the main repo: `git add PROGRESS.md LESSONS_LEARNED.md TESTING.md && git commit -m "docs: 2026-08-04 diagnostic checkpoint and lessons"`.

---

## Self-Review (author)

- Spec coverage: sanitizer bug (Task 2), dishonest miss reason (Task 3), swallowed JSON load failure (Task 4), preview opacity (Task 5 + docs), PR salvage (Task 1), corrected-workbook readiness (Task 6), gates and memory (Tasks 7-8). Excluded scope stated in Global Constraints.
- Placeholders: none; all code verbatim. Harness-mirroring notes reference an existing repo file (route.d4.test.ts), not a plan task.
- Type consistency: `deterministicMissBody(reasonCode, reason)` matches route.ts:61; `tireJsonIndexStatus` name used identically in Task 4 test, impl, and health route; `trustedExact.allowlistConfigured` matches between Task 5 test and impl.
