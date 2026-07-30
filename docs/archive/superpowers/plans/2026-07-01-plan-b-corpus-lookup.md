# Plan B — Make the deterministic corpus lookups work on Vercel (free known-code resolution)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make known barcodes (starting with the ~76K committed tire corpus) resolve deterministically for FREE on the deployed app, instead of every scan falling through to a paid AI decode — and make silent retail-Turso failures visible.

**Architecture:** Root cause (confirmed): every deterministic lookup goes through `getKnowledgeDb()` (a better-sqlite3 DB loaded from `knowledge.generated.db[.gz]`). That DB file is NOT deployed to Vercel (the `.gz` was reverted from git as too large, commit `decc1ac`, and is gitignored), so `getKnowledgeDb()` returns `null`, `lookupByExactBarcode()` returns `null` for every code, and every scan — including the 122 of the owner's 174 that ARE in the committed corpus — hits paid AI. Fix: add an in-memory index built from the committed `tireKnowledge.generated.json` (`barcodeIndex` / `partNumberIndex`) that serves lookups when SQLite is unavailable; ship the JSON in the function bundle; and tag retail-Turso errors distinctly from misses so failures are observable.

**Tech Stack:** TypeScript, Next.js server route `/api/ai-lookup`, Vitest, Playwright/curl for the deployed-preview proof.

## Global Constraints

- Deterministic, EXACT lookups only — never fuzzy/near-match (unchanged rule).
- The fix must be **server-side only** and must not spend any AI on a corpus hit (a hit returns before the Gemini/OpenAI path).
- Do not change the resolver's trust rules, the store, or Plan A's counting — this is purely the server-side corpus-lookup data path.
- No paid APIs; no external credentials required (the tire JSON is already committed). Retail Turso keeps using the creds Vercel already has.
- Preview deploy only. Never merge to master / deploy to production without explicit owner sign-off.
- Verification Gate (same as Plan A, inherited): each task proven before advancing; loop-until-fixed with `superpowers:systematic-debugging`; never advance while red. Because the value is server-side (not UI), the "browser" proof for the key task is a **curl against the deployed preview `/api/ai-lookup`** confirming a tire code resolves with `aiCalled:false`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts` — add an in-memory JSON index fallback used when `getKnowledgeDb()` is null.
- Modify: `next.config.ts` — replace the dead `.gz` trace include with the committed tire JSON so it ships in the `/api/ai-lookup` bundle.
- Modify: `src/server/retail-knowledge/retailKnowledgeIndex.ts` — distinguish a Turso *error* from a *miss* and expose it.
- Modify: `src/app/api/ai-lookup/route.ts` — surface the retail lookup status (error vs miss) in the decode debug payload (exact field located by the implementer).
- Test: `src/server/tire-knowledge/tireKnowledgeIndex.jsonfallback.test.ts` (new), and an integration test that a tire code short-circuits before AI.

## Interfaces

- `lookupByExactBarcode(code)` / `lookupByExactPartNumber(pn)` keep their signatures (`Promise<TireKnowledgeRow | null>`); behavior gains a JSON fallback.
- The tire JSON shape (verified): `{ schema_version, generated_at, barcodeIndex: Record<barcode, TireKnowledgeRow>, partNumberIndex: Record<partNumber, uid:string>, identityIndex: Record<identity, uid:string> }`. `barcodeIndex` values are FULL rows; `partNumberIndex` values are uid strings that must be resolved to a row via a uid→row map built from `barcodeIndex`.

---

### Task 1: In-memory tire index fallback (the core fix)

**Files:**
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts`
- Modify: `next.config.ts`
- Test: `src/server/tire-knowledge/tireKnowledgeIndex.jsonfallback.test.ts` (new)

**Interfaces:**
- Produces: the JSON-fallback behavior on `lookupByExactBarcode` / `lookupByExactPartNumber`.

- [ ] **Step 1: Write the failing test**

Create `src/server/tire-knowledge/tireKnowledgeIndex.jsonfallback.test.ts`. It forces the SQLite path unavailable (`__resetKnowledgeDbForTests` leaves it "missing" because no DB file exists in the test env) and asserts a real committed tire barcode resolves via the JSON index, and a non-corpus code misses:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { lookupByExactBarcode, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { __resetKnowledgeDbForTests } from "@/server/knowledgeDb";

// A barcode confirmed present in the committed barcodeIndex (see tireKnowledge.generated.json).
const KNOWN_TIRE_BARCODE = "848983006257";

describe("tire index resolves from the committed JSON when SQLite is unavailable (Vercel case)", () => {
  beforeEach(() => { __resetKnowledgeDbForTests(); __resetTireKnowledgeCacheForTests(); });

  it("resolves a known committed tire barcode with no SQLite DB present", async () => {
    const row = await lookupByExactBarcode(KNOWN_TIRE_BARCODE);
    expect(row).not.toBeNull();
    expect(row!.barcode ?? KNOWN_TIRE_BARCODE).toBeTruthy();
    expect(row!.brand).toBeTruthy(); // a real row, not a stub
  });

  it("misses a code that is not in the corpus", async () => {
    const row = await lookupByExactBarcode("000000000000");
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/tire-knowledge/tireKnowledgeIndex.jsonfallback.test.ts`
Expected: FAIL — `lookupByExactBarcode` returns null today (SQLite absent, no JSON fallback yet).

- [ ] **Step 3: Add the in-memory JSON fallback**

In `src/server/tire-knowledge/tireKnowledgeIndex.ts`, add (after the existing imports and `normPartKey`):

```typescript
import { readFileSync } from "node:fs";

const TIRE_JSON_PATH = join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.json");

interface TireJsonIndex {
  barcodeIndex: Record<string, TireKnowledgeRow>;
  partNumberIndex: Record<string, string>;
}
let _jsonIndex: TireJsonIndex | null | "missing" = null;
let _uidToRow: Map<string, TireKnowledgeRow> | null = null;

/** Load the committed tire JSON into memory once (cached for the process lifetime). Used when the
 *  SQLite knowledge DB is unavailable (the normal case on Vercel, where the .db file is not bundled). */
function getJsonIndex(): TireJsonIndex | null {
  if (_jsonIndex === "missing") return null;
  if (_jsonIndex) return _jsonIndex;
  try {
    const parsed = JSON.parse(readFileSync(TIRE_JSON_PATH, "utf8")) as TireJsonIndex;
    _jsonIndex = { barcodeIndex: parsed.barcodeIndex ?? {}, partNumberIndex: parsed.partNumberIndex ?? {} };
    _uidToRow = new Map();
    for (const row of Object.values(_jsonIndex.barcodeIndex)) _uidToRow.set(row.canonical_product_uid, row);
    return _jsonIndex;
  } catch (e) {
    console.warn("[tire-knowledge] in-memory JSON index load failed:", (e as Error).message);
    _jsonIndex = "missing";
    return null;
  }
}
```

Then change the two lookups to fall back to the JSON index when SQLite is unavailable:

```typescript
export async function lookupByExactBarcode(code: string): Promise<TireKnowledgeRow | null> {
  const key = normBarcodeKey(code);
  if (!key) return null;
  const stmt = getStmtBarcode();
  if (stmt) return (stmt.get(key) as TireKnowledgeRow | undefined) ?? null;
  const idx = getJsonIndex();
  return idx ? (idx.barcodeIndex[key] ?? null) : null;
}

export async function lookupByExactPartNumber(partNumber: string): Promise<TireKnowledgeRow | null> {
  const key = normPartKey(partNumber);
  if (!key) return null;
  const stmt = getStmtPartNumber();
  if (stmt) return (stmt.get(key) as TireKnowledgeRow | undefined) ?? null;
  const idx = getJsonIndex();
  if (!idx) return null;
  const uid = idx.partNumberIndex[key];
  return uid && _uidToRow ? (_uidToRow.get(uid) ?? null) : null;
}
```

Also extend the test reset so a regenerated index is re-read — in `__resetTireKnowledgeCacheForTests`, add `_jsonIndex = null; _uidToRow = null;`.

- [ ] **Step 4: Ship the JSON in the Vercel bundle**

In `next.config.ts`, replace the dead `.gz` include:

```typescript
  outputFileTracingIncludes: {
    "/api/ai-lookup": ["./src/server/tire-knowledge/tireKnowledge.generated.json"],
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/server/tire-knowledge/tireKnowledgeIndex.jsonfallback.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Full unit suite + typecheck**

Run: `npm run test` (expect 0 failures — the existing `tireKnowledge.test.ts` must still pass; if it mocked SQLite in a way the fallback changes, reconcile it honestly, don't weaken).
Run: `npx tsc --noEmit` (clean).

- [ ] **Step 7: Commit**

```bash
git add src/server/tire-knowledge/tireKnowledgeIndex.ts next.config.ts src/server/tire-knowledge/tireKnowledgeIndex.jsonfallback.test.ts
git commit -m "fix(corpus): in-memory tire index fallback so known barcodes resolve free on Vercel (no SQLite)"
```

---

### Task 2: Make retail-Turso failures visible (observability)

**Files:**
- Modify: `src/server/retail-knowledge/retailKnowledgeIndex.ts`
- Modify: `src/app/api/ai-lookup/route.ts` (surface the status in the decode debug payload)
- Test: extend/add a retail-knowledge test

**Interfaces:**
- Produces: a way for the route to know whether the retail lookup returned a genuine miss vs a swallowed Turso error.

- [ ] **Step 1: Write the failing test**

Add a test that a Turso `execute` throwing surfaces an ERROR status (not an indistinguishable null). Mock `@libsql/client`'s `createClient` to return a client whose `execute` rejects, set `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` env for the test, and assert the new status accessor reports an error:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("retail Turso errors are distinguishable from misses", () => {
  beforeEach(() => { vi.resetModules(); process.env.TURSO_DATABASE_URL = "libsql://x"; process.env.TURSO_AUTH_TOKEN = "t"; });
  it("reports an error status when the Turso query throws", async () => {
    vi.doMock("@libsql/client", () => ({ createClient: () => ({ execute: async () => { throw new Error("auth failed"); } }) }));
    const mod = await import("@/server/retail-knowledge/retailKnowledgeIndex");
    mod.__resetRetailKnowledgeCacheForTests();
    const res = await mod.lookupRetailBarcodeAsync("049000006346");
    expect(res).toBeNull();
    expect(mod.getLastRetailLookupStatus()).toBe("turso_error");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run -t "distinguishable from misses"`
Expected: FAIL — `getLastRetailLookupStatus` does not exist yet.

- [ ] **Step 3: Implement the status signal**

In `retailKnowledgeIndex.ts`, add a module-level status and set it in `lookupTurso`'s catch and success/miss paths, plus export an accessor:

```typescript
type RetailLookupStatus = "idle" | "sqlite_hit" | "turso_hit" | "turso_miss" | "turso_error" | "unavailable";
let _lastStatus: RetailLookupStatus = "idle";
export function getLastRetailLookupStatus(): RetailLookupStatus { return _lastStatus; }
```

Set `_lastStatus` at each outcome: `"unavailable"` when no client, `"turso_hit"` on a row, `"turso_miss"` on zero rows, `"turso_error"` in the `catch` (keep the existing `console.warn`, keep returning null so the scan never blocks). Reset to `"idle"` in `__resetRetailKnowledgeCacheForTests`.

- [ ] **Step 4: Surface it in the route**

In `src/app/api/ai-lookup/route.ts`, after the `lookupRetailBarcodeAsync(code)` call in `computeDecode()` (near the RETAIL PRODUCT KNOWLEDGE INDEX block), read `getLastRetailLookupStatus()` and include it in the decode response `debug` object (locate the existing debug/`corroborationPath` field and add e.g. `retailLookup: <status>`). Do not change control flow — a corpus miss still proceeds to AI; this only makes the reason visible in the network panel / logs.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/server/retail-knowledge` and `npm run test` (0 failures). `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/retail-knowledge/retailKnowledgeIndex.ts src/app/api/ai-lookup/route.ts src/server/retail-knowledge/*.test.ts
git commit -m "feat(observability): tag retail Turso error vs miss so silent failures are visible"
```

---

### Task 3: Integration + deployed-preview proof

**Files:**
- Test: `src/app/api/ai-lookup/decode-corpus.test.ts` (new) OR extend an existing route test
- Proof: a curl against the deployed preview

**Interfaces:** consumes Tasks 1-2.

- [ ] **Step 1: Write an integration test — a tire code resolves with NO AI call**

Locate how the route/`computeDecode` is tested (grep `computeDecode` / existing `route` tests). Write a test that drives the decode path for a committed tire barcode with the AI providers mocked to THROW if called, and asserts the response indicates a corpus hit and `aiCalled` is false (no provider invocation). Use the same `KNOWN_TIRE_BARCODE` from Task 1. If the route is hard to unit-test in isolation, instead assert at the `computeDecode` seam that a tire barcode returns the corpus result before any provider function is reached (spy on the provider entry and assert 0 calls).

- [ ] **Step 2: Run it green**

Run: `npx vitest run src/app/api/ai-lookup/decode-corpus.test.ts` → PASS. Then `npm run test` (0 failures), `npx tsc --noEmit`, `npm run build` (success — confirms the JSON is included and the bundle builds).

- [ ] **Step 3: Deployed-preview proof (the real gate)**

After the branch is pushed and Vercel builds the preview, curl the deployed route with a committed tire barcode and confirm it resolves WITHOUT AI (server-side, real bundle):

```bash
# Replace <preview-url> with the branch preview URL from the PR.
curl -s -X POST "<preview-url>/api/ai-lookup" -H "Content-Type: application/json" \
  -d '{"mode":"decode","rawCode":"848983006257","cleanCode":"848983006257","codeType":"upc_a"}' | head -c 800
```

Expected: a response identifying the tire product from the corpus with `aiCalled:false` (or the equivalent corpus-hit marker). If it still shows an AI call, the JSON was not bundled — check `outputFileTracingIncludes` and the build's included-files list. Capture the output to the report.

- [ ] **Step 4: Commit the integration test**

```bash
git add src/app/api/ai-lookup/decode-corpus.test.ts
git commit -m "test: tire barcode resolves from corpus with no AI call (integration)"
```

---

## Self-Review

**Spec coverage:**
- Root cause (SQLite absent on Vercel) → Task 1 in-memory JSON fallback + bundle the JSON.
- Silent retail failures → Task 2 observability.
- Proof that known codes now resolve free on the real deployment → Task 3 (unit + integration + preview curl).
- Out of scope (documented): moving tires into Turso (needs owner creds — Path B), removing the better-sqlite3 dependency entirely, and compacting the 53MB JSON (optimize only if cold-start/bundle size proves a problem — YAGNI).

**Placeholder scan:** Task 1 and next.config carry complete code. Tasks 2-3 name exact files + the exact new symbols (`getLastRetailLookupStatus`, `RetailLookupStatus`) and the precise seam to test; the implementer grounds the one route debug-field name by reading `route.ts` (a real, named lookup, not a vague instruction).

**Type consistency:** `getJsonIndex`/`_jsonIndex`/`_uidToRow` and `TireJsonIndex` are defined once and used in both lookups; `RetailLookupStatus`/`getLastRetailLookupStatus` are consistent across the retail module, its test, and the route.
