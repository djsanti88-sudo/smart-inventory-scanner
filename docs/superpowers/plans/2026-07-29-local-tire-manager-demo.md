# Local Tire Manager Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and certify a one-command, fail-closed localhost Scanbin demo that decodes 3,000 local tire-database barcodes through ChatGPT-controlled Chrome with zero external calls and zero wrong verified identities.

**Architecture:** A server-only `SCANBIN_LOCAL_DEMO=1` mode limits the existing decode pipeline to exact local tire-corpus resolution and returns an honest unresolved payload on a miss. A deterministic read-only SQLite sampler locks 3,000 expected tire identities into 30 batches of 100. Ten rotated lower-tier agents drive the real scanner UI in Chrome, record batch evidence, and feed confirmed failures into a focused test-fix-retest loop.

**Tech Stack:** Next.js 16.2.9, React 19.2.4, TypeScript, Node.js 20-compatible ESM scripts, better-sqlite3, Vitest/node:test, Zustand, ChatGPT Chrome control.

## Global Constraints

- Localhost only. Do not push, open a PR, deploy, or access GitHub/Vercel.
- Do not read or write production Firebase or Turso.
- Do not call UPCitemdb, Go-UPC, Fetch V2, Brave, Firecrawl, OpenAI, Gemini, or another network decode provider.
- Do not run repository Playwright/E2E suites. ChatGPT-controlled Chrome is the acceptance surface.
- Select only tires from `src/server/knowledge.generated.db`; use 3,000 unique database barcodes in 30 batches of 100.
- Every physical scan must appear and count even when identity is unresolved or rejected.
- Wrong identity is worse than unknown. Only exact trusted corpus evidence may produce `verified`.
- Preserve the primary checkout and every unrelated modified/untracked file.
- Workers do not commit. The coordinator reviews, verifies, and creates local commits with explicit paths.
- Generated proof output belongs under ignored `reports/local-tire-demo/` and is never committed.

---

### Task 1: Fail-closed local-demo environment and launcher

**Files:**
- Create: `src/server/localDemo.ts`
- Create: `src/server/localDemo.test.ts`
- Create: `src/server/tire-knowledge/localDemoTrust.mjs`
- Create: `src/server/tire-knowledge/localDemoTrust.test.ts`
- Create: `scripts/local-demo-environment.mjs`
- Create: `scripts/local-demo-environment.test.mjs`
- Create: `scripts/local-demo-preflight.mjs`
- Create: `scripts/local-demo-preflight.test.mjs`
- Create: `scripts/local-demo-egress-guard.cjs`
- Create: `scripts/local-demo-egress-guard.test.mjs`
- Create: `scripts/local-demo.mjs`
- Create: `scripts/local-demo.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `process.env`, `scripts/dev-environment.mjs`
- Produces:
  - `isLocalDemo(): boolean`
  - `buildLocalDemoEnvironment(baseEnvironment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `assertLocalDemoDatabase(databasePath?: string): { databasePath: string; databaseSha256: string; tireCount: number; eligibleTireCount: number }`
  - `npm run demo:local`

- [ ] **Step 1: Write the server-mode test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { isLocalDemo } from "./localDemo";

const original = process.env.SCANBIN_LOCAL_DEMO;
afterEach(() => {
  if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO;
  else process.env.SCANBIN_LOCAL_DEMO = original;
});

describe("isLocalDemo", () => {
  it("is enabled only by the explicit value 1", () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    expect(isLocalDemo()).toBe(true);
    process.env.SCANBIN_LOCAL_DEMO = "true";
    expect(isLocalDemo()).toBe(false);
    delete process.env.SCANBIN_LOCAL_DEMO;
    expect(isLocalDemo()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the server-mode test and verify it fails**

Run:

```powershell
npx.cmd vitest run src/server/localDemo.test.ts
```

Expected: FAIL because `src/server/localDemo.ts` does not exist.

- [ ] **Step 3: Implement the mode helper**

```ts
import "server-only";

export function isLocalDemo(): boolean {
  return process.env.SCANBIN_LOCAL_DEMO === "1";
}
```

- [ ] **Step 4: Write the environment test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalDemoEnvironment } from "./local-demo-environment.mjs";

test("local demo scrubs every external service and pins local-only mode", () => {
  const env = buildLocalDemoEnvironment({
    TURSO_DATABASE_URL: "libsql://example",
    TURSO_AUTH_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    GO_UPC_API_KEY: "secret",
    BRAVE_SEARCH_API_KEY: "secret",
    FIRECRAWL_API_KEY: "secret",
    FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: "secret",
    FIREBASE_SERVICE_ACCOUNT_PATH: "C:/secret.json",
    NEXT_PUBLIC_CLOUD_CATALOG: "1",
    NEXT_PUBLIC_FIREBASE_ALLOW_PROD: "1",
    NEXT_PUBLIC_AUTH_MODE: "live",
    NEXT_PUBLIC_REQUIRE_LOGIN: "1",
  });
  assert.equal(env.SCANBIN_LOCAL_DEMO, "1");
  assert.equal(env.NEXT_PUBLIC_LOCAL_DEMO, "1");
  assert.equal(env.NEXT_PUBLIC_FIREBASE_BACKEND, "0");
  assert.equal(env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR, "0");
  assert.equal(env.NEXT_PUBLIC_AUTH_MODE, "mock");
  assert.equal(env.NEXT_PUBLIC_REQUIRE_LOGIN, "0");
  assert.equal(env.NEXT_PUBLIC_E2E_AUTH_BYPASS, "");
  assert.equal(env.ENABLE_LIVE_AI_LOOKUP, "false");
  for (const key of [
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GO_UPC_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "FIRECRAWL_API_KEY",
    "FIREBASE_SERVICE_ACCOUNT_JSON_BASE64",
    "FIREBASE_SERVICE_ACCOUNT_PATH",
    "NEXT_PUBLIC_CLOUD_CATALOG",
    "NEXT_PUBLIC_FIREBASE_ALLOW_PROD",
  ]) assert.equal(env[key], "");
});
```

Add a hostile-env fixture test which writes `.env.local` values for every denied key, loads the
result with the exact `@next/env` logic used by Next's production build, and proves the child
environment's already-defined empty/safe values cannot be repopulated. Also prove
`isLiveAuth() === false`, `isLocalRuntime() === true`, and the full local persistence shape survives
serialization/reload with `NODE_ENV=production`; local-demo mode must not depend on the E2E auth
bypass.

- [ ] **Step 5: Run the environment test and verify it fails**

Run:

```powershell
node --test scripts/local-demo-environment.test.mjs
```

Expected: FAIL because the environment builder does not exist.

- [ ] **Step 6: Implement the fail-closed environment**

`buildLocalDemoEnvironment()` must start from `buildDevEnvironment("mock", baseEnvironment)`, set
`SCANBIN_LOCAL_DEMO=1`, `NEXT_PUBLIC_LOCAL_DEMO=1`, `NEXT_PUBLIC_AUTH_MODE=mock`,
`NEXT_PUBLIC_REQUIRE_LOGIN=0`, `NEXT_PUBLIC_FIREBASE_BACKEND=0`,
`NEXT_PUBLIC_FIREBASE_USE_EMULATOR=0`, `NEXT_PUBLIC_E2E_AUTH_BYPASS=""`,
`ENABLE_LIVE_AI_LOOKUP=false`, `ENABLE_AUTO_DECODE_ON_SCAN=true`, and
`NEXT_TELEMETRY_DISABLED=1`. Set every denied key below to the defined empty string instead of
deleting it, so Next's `.env*.local` loader cannot rehydrate a host secret into build/start:

```text
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
OPENAI_API_KEY
GO_UPC_API_KEY
BRAVE_SEARCH_API_KEY
BRAVE_API_KEY
FIRECRAWL_API_KEY
FIRECRAWL_BASE_URL
GOOGLE_GENERATIVE_AI_API_KEY
GEMINI_API_KEY
GOOGLE_API_KEY
FIREBASE_SERVICE_ACCOUNT_JSON
FIREBASE_SERVICE_ACCOUNT_JSON_BASE64
FIREBASE_SERVICE_ACCOUNT_PATH
GOOGLE_APPLICATION_CREDENTIALS
NEXT_PUBLIC_CLOUD_CATALOG
NEXT_PUBLIC_FIREBASE_ALLOW_PROD
```

The test must import the checked-in Next `@next/env` implementation and prove this behavior against
a temporary hostile `.env.local`; a mock of the loader is not sufficient.

- [ ] **Step 7: Write and verify the database preflight tests**

Create temporary SQLite fixtures and assert:

```js
const result = assertLocalDemoDatabase(validDatabasePath);
assert.equal(result.tireCount, 3000);
assert.equal(result.eligibleTireCount, 3000);
assert.match(result.databaseSha256, /^[a-f0-9]{64}$/);
assert.throws(() => assertLocalDemoDatabase(missingPath), /local tire database is required/i);
assert.throws(() => assertLocalDemoDatabase(corruptPath), /quick_check/i);
assert.throws(() => assertLocalDemoDatabase(tooSmallDatabasePath), /at least 3000/i);
```

Run:

```powershell
node --test scripts/local-demo-preflight.test.mjs
```

Expected: FAIL because the preflight module does not exist.

- [ ] **Step 8: Implement the read-only database preflight**

Open `src/server/knowledge.generated.db` using
`new Database(path, { readonly: true, fileMustExist: true })`. Require `PRAGMA quick_check` to return
`ok`, require at least 3,000 rows in `tires`, and independently count at least 3,000 rows satisfying
the Task 2/4 conservative trust predicate by importing
`src/server/tire-knowledge/localDemoTrust.mjs`. This Task creates that single executable predicate
module plus the checksum-parity tests described in Task 2. Compute SHA-256 by
streaming the database file, close the database in `finally`, and return the exact interface above.
Never create or mutate the database.

- [ ] **Step 9: Add and prove a process-wide external-egress guard**

`scripts/local-demo-egress-guard.cjs` is loaded into both `next build` and `next start` through an
absolute `NODE_OPTIONS=--require=<path>` entry. It allows loopback (`localhost`, `127.0.0.0/8`, and
`::1`) and local file/IPC operations only. It blocks every other target before DNS/socket use across
`globalThis.fetch`, `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`, DNS resolver
entry points, datagram send/connect, and WebSocket-capable client paths. After patching CommonJS
builtin exports it calls `syncBuiltinESMExports()` so later ESM named imports cannot retain the
original functions.

Each blocked attempt appends one sanitized JSON line (`pid`, timestamp, method/protocol/host/path
without query) to a new run-scoped file whose absolute path is supplied in
`SCANBIN_LOCAL_DEMO_EGRESS_LEDGER`. The launcher creates this file under ignored
`reports/local-tire-demo/runtime/`, validates the resolved path stays inside that directory, and
passes the same path to every build/server worker. This filesystem ledger, not process-global
memory, is the cross-process proof source.

Tests must launch isolated child processes with the guard preloaded and prove:

- deliberate external canaries through fetch, HTTP, HTTPS, HTTP/2, net, TLS, DNS, datagram, and
  WebSocket (when present) fail before DNS/socket use;
- ESM imports made after preload are blocked as strongly as CommonJS calls;
- loopback HTTP remains usable;
- the ledger records a sanitized blocked destination;
- a blocked attempt in a spawned worker is visible in the parent/status ledger;
- the safe child environment plus guard remains inherited by spawned Next worker children.

- [ ] **Step 10: Implement the launcher**

`scripts/local-demo.mjs` must:

1. reject `--prod` and `--emulator`;
2. derive the safe child environment from `buildLocalDemoEnvironment()`;
3. call `assertLocalDemoDatabase()` before build/start and fail with the exact remediation command
   `node scripts/provision-worktree.mjs` when the worktree-local database is absent;
4. reject `--skip-build`, preload the egress guard, and always run a fresh `next build` using the
   same safe child environment as the server;
5. run `next start -H 127.0.0.1 -p <port>` with port 3400 by default, reject any host override, and
   prove the actual listener accepts loopback while refusing the machine's non-loopback interface;
6. propagate non-zero child exit codes;
7. print a green banner containing `LOCAL TIRE DEMO`, `localhost:<port>`, the database SHA-256, tire
   row count, and `external decode disabled`.

Add:

```json
"demo:local": "node scripts/local-demo.mjs",
"demo:provision": "node scripts/provision-worktree.mjs"
```

- [ ] **Step 11: Verify Task 1**

Run:

```powershell
node --test scripts/local-demo-environment.test.mjs
node --test scripts/local-demo-preflight.test.mjs
node --test scripts/local-demo-egress-guard.test.mjs
node --test scripts/local-demo.test.mjs
npx.cmd vitest run src/server/localDemo.test.ts
npx.cmd vitest run src/server/tire-knowledge/localDemoTrust.test.ts
npx.cmd eslint src/server/localDemo.ts src/server/tire-knowledge/localDemoTrust.mjs scripts/local-demo-environment.mjs scripts/local-demo-preflight.mjs scripts/local-demo-egress-guard.cjs scripts/local-demo.mjs
```

Expected: all commands exit 0.

---

### Task 2: Restrict the decode route and pipeline to the local tire corpus

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts`
- Modify: `src/server/decode/pipeline.ts`
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.ts`
- Modify: `src/server/tire-knowledge/tireKnowledgeIndex.test.ts`
- Modify: `src/server/tire-knowledge/localDemoTrust.mjs`
- Modify: `src/server/tire-knowledge/localDemoTrust.test.ts`
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.ts`
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.test.ts`
- Create: `src/server/decode/pipeline.localDemo.test.ts`
- Modify: `src/app/api/ai-lookup/route.test.ts`

**Interfaces:**
- Consumes: `isLocalDemo()`, `resolveExactBarcode()`, `DecodePayload`
- Produces:
  - `lookupByExactBarcodeLocal(code: string): Promise<TireKnowledgeRow | null>`
  - `resolveExactBarcodeLocal(code: string): Promise<CorpusDecodeResult | null>`
  - `isTrustedLocalDemoTireRow(row: TireKnowledgeRow): boolean`
  - trusted local exact hit: existing `corpus_exact_barcode` verified payload
  - absent or ineligible exact row: `local_demo_corpus_miss` needs-review payload
  - local exact-hit debug: `canonicalProductUid` for Chrome proof, absent outside local-demo mode

- [ ] **Step 1: Write failing pipeline tests**

The tests must mock all storage/network-capable seams and prove:

```ts
expect(result.kind).toBe("computed");
expect(result.payload.decision.status).toBe("needs_review");
expect(result.payload.reasonCode).toBe("no_result");
expect(result.payload.providerNames).toEqual(["local-tire-corpus"]);
expect(result.payload.debug).toMatchObject({
  corroborationPath: "local_demo_corpus_miss",
  ladderPath: "none",
  aiCalled: false,
  pageFetched: false,
});
expect(ladderStorage).not.toHaveBeenCalled();
expect(lookupRetailBarcodeAsync).not.toHaveBeenCalled();
expect(getLearnedProduct).not.toHaveBeenCalled();
expect(lookupMasterCatalog).not.toHaveBeenCalled();
expect(global.fetch).not.toHaveBeenCalled();
```

A second test must return a mocked eligible exact corpus hit and assert the existing verified result
is preserved while `ladderStorage`, `fetch`, and `maybeAppendMasterCatalogEntry` remain untouched.
It must also assert `payload.debug.canonicalProductUid` equals the SQLite row's canonical ID in
local-demo mode and is absent when local-demo mode is disabled.

Add table-driven provider/pipeline tests proving an exact SQLite row remains `needs_review` and
never touches a later rung when any one trust condition is false: invalid checksum; empty canonical
ID, brand, model, or size; status other than `active_retail`; `usable_for` other than
`auto_count_candidate`; `source_count < 2`; barcode type other than `upc`/`ean`. Include the pinned
database's non-zero-indicator GTIN-14 shape explicitly.

Add index/provider tests proving local lookup:

```ts
await expect(lookupByExactBarcodeLocal(knownCode)).resolves.toMatchObject({ barcode: knownCode });
await expect(lookupByExactBarcodeLocal(missingCode)).resolves.toBeNull();
expect(getTursoClient).not.toHaveBeenCalled();
expect(readFileSync).not.toHaveBeenCalled();
```

When the SQLite statement cannot be created, require:

```ts
await expect(lookupByExactBarcodeLocal(knownCode)).rejects.toThrow(/local SQLite tire database is unavailable/i);
```

- [ ] **Step 2: Verify the pipeline tests fail**

Run:

```powershell
npx.cmd vitest run src/server/decode/pipeline.localDemo.test.ts
```

Expected: FAIL because SQLite-only lookup and local-demo short-circuiting do not exist.

- [ ] **Step 3: Add SQLite-only exact tire lookup**

`lookupByExactBarcodeLocal()` must normalize candidates exactly like `lookupByExactBarcode()`, use
only `getStmtBarcode()`, and throw when the SQLite statement is unavailable. It must not call
`lookupBarcodeTurso()` or `getJsonIndex()`.

Implement `isTrustedLocalDemoTireRow()` and its check-digit helper once in the pure, server-safe
`localDemoTrust.mjs`. The provider, preflight, and sampler all import that same executable module;
a Vitest parity test also compares its checksum results with the existing
`src/services/upc/gtin.ts::isValidCheckDigit` over UPC/EAN/GTIN valid and invalid vectors. The
predicate is fail closed and returns true only for a non-empty canonical ID, brand, model, and size; exact
`active_retail` status; exact `auto_count_candidate` usability; `source_count >= 2`; and barcode type
`upc` or `ean`. It rejects every GTIN-14 row, regardless of whether the database has a current exact
match. `resolveExactBarcodeLocal()` may reuse the existing verified result shaping only after this
predicate passes; otherwise it returns null and the pipeline returns `needs_review`. It also carries
the row's canonical ID on `CorpusDecodeResult`. `corpusPayload()` may copy that ID into `debug` only
when `isLocalDemo()` is true; normal responses must not gain a new internal identifier.

- [ ] **Step 4: Add a local miss payload helper**

The helper must return:

```ts
{
  mode: "decode",
  providerNames: ["local-tire-corpus"],
  results: [],
  evidences: [],
  providerStatuses: [{
    provider: "local-tire-corpus",
    status: "skipped",
    latencyMs: 0,
    sourceUrlsReturned: 0,
    exactCodeFound: false,
    identityFound: false,
    errorCode: "local_demo_corpus_miss",
  }],
  decision: {
    status: "needs_review",
    confidence: 0,
    reason: "No exact match was found in the local tire database.",
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: 0,
      reason: "Local tire corpus miss.",
      brandSimilarity: 0,
      nameSimilarity: 0,
      contradictions: [],
    },
  },
  reasonCode: "no_result",
  reasonText: "No exact match was found in the local tire database.",
  timedOut: false,
  debug: {
    providersAttempted: ["local-tire-corpus"],
    evidenceStrengths: [],
    sourceCounts: [],
    corroborationPath: "local_demo_corpus_miss",
    ladderPath: "none",
    ladderReasons: [{ rung: "local-tire-corpus", reason: "exact local tire match not found" }],
    aiCalled: false,
    pageFetched: false,
    cached: false,
  },
  sanitizedInput: { rawCodeSanitized, cleanCodeSanitized },
}
```

- [ ] **Step 5: Short-circuit before any storage/network rung**

Inside `runDecodePipeline()`:

- make `appendDecodeOutcome()` return immediately in local-demo mode;
- run `resolveExactBarcodeLocal()` instead of the fallback-capable resolver;
- return the existing corpus payload on a hit;
- on a miss, return the local miss payload before retail, learned, master, L2 cache, caps, or ladder
  logic.

- [ ] **Step 6: Block the post-decode master-catalog append**

Guard `maybeAppendMasterCatalogEntry()` at its first executable line with `isLocalDemo()`. Route POST
tests must cover both an exact corpus hit and an unresolved miss and assert:

```ts
expect(appendMasterCatalogEntry).not.toHaveBeenCalled();
expect(getAdminDb).not.toHaveBeenCalled();
```

- [ ] **Step 7: Make the route status endpoint storage-free**

When `isLocalDemo()` is true, `GET /api/ai-lookup` must return a static response whose relevant fields
are:

```ts
{
  liveEnabled: false,
  autoDecodeOnScan: true,
  freeDecodeAvailable: true,
  localDemo: true,
  externalDecodeEnabled: false,
  openWebFallback: false,
  pageFetchAndRead: false,
  premiumFallback: false,
  missingKeys: [],
  e2e: false,
  decodeLadder: ["local_tire_corpus"],
  geminiUsedForDecode: false,
  daily: { used: 0, limit: 0 },
  gptLadder: { spentTodayUsd: 0, capUsd: 0, callsToday: 0, enabled: false },
  goUpc: { configured: false, used: 0, limit: 0, unlimited: false, warn: false },
}
```

The route test must mock `ladderStorage` and assert it is never called for this GET.

- [ ] **Step 8: Verify Task 2**

Run:

```powershell
npx.cmd vitest run src/server/tire-knowledge/tireKnowledgeIndex.test.ts src/server/tire-knowledge/TireKnowledgeProvider.test.ts src/server/decode/pipeline.localDemo.test.ts src/app/api/ai-lookup/route.test.ts src/app/api/ai-lookup/decode-corpus.test.ts
npx.cmd eslint src/server/tire-knowledge/tireKnowledgeIndex.ts src/server/tire-knowledge/TireKnowledgeProvider.ts src/server/decode/pipeline.ts src/app/api/ai-lookup/route.ts src/server/decode/pipeline.localDemo.test.ts
```

Expected: all commands exit 0 and all egress/storage spies remain at zero.

---

### Task 3: Block non-pipeline egress and show an unambiguous local/offline state

**Files:**
- Modify: `src/stores/scanStore.ts`
- Create: `src/stores/localDemoEgress.store.test.ts`
- Modify: `src/lib/telemetry.ts`
- Modify: `src/lib/telemetry.test.ts`
- Modify: `src/app/api/telemetry/route.ts`
- Modify: `src/app/api/telemetry/route.test.ts`
- Modify: `src/app/api/prefix-floor/route.ts`
- Modify: `src/app/api/prefix-floor/route.test.ts`
- Modify: `src/app/api/catalog-dispute/route.ts`
- Modify: `src/app/api/catalog-dispute/route.test.ts`
- Create: `src/proxy.ts`
- Create: `src/proxy.localDemo.test.ts`
- Modify: `src/app/api/reconcile/match/route.ts`
- Modify: `src/app/api/reconcile/match/route.test.ts`
- Modify: `src/app/api/import-mapping/route.ts`
- Modify: `src/app/api/import-mapping/route.test.ts`
- Modify: `src/app/api/share/route.ts`
- Modify: `src/app/api/share/route.test.ts`
- Modify: `src/app/api/share/[token]/route.ts`
- Modify: `src/app/api/share/[token]/route.test.ts`
- Modify: `src/app/api/catalog-review/route.ts`
- Modify: `src/app/api/catalog-review/[id]/route.ts`
- Modify: `src/app/api/catalog-review/route.test.ts`
- Modify: `src/app/api/catalog-review/[id]/route.test.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`
- Create: `src/app/layout.localDemo.test.tsx`
- Modify: `src/components/SpeedInsightsTelemetry.tsx`
- Modify: `src/components/SpeedInsightsTelemetry.test.tsx`
- Modify: `src/components/ProdFirebaseBanner.tsx`
- Modify: `src/components/ProdFirebaseBanner.test.tsx`
- Modify: `src/components/Nav.tsx`
- Create: `src/components/Nav.localDemo.test.tsx`
- Modify: `src/components/UniversalImportPanelContainer.tsx`
- Modify: `src/components/UniversalImportPanelContainer.test.tsx`
- Modify: `src/app/(app)/report/page.tsx`
- Modify: `src/app/(app)/report/reportShare.test.tsx`
- Create: `src/app/api/local-demo/status/route.ts`
- Create: `src/app/api/local-demo/status/route.test.ts`
- Create: `src/app/api/local-demo/manifest/[batch]/route.ts`
- Create: `src/app/api/local-demo/manifest/[batch]/route.test.ts`

**Interfaces:**
- Consumes: `SCANBIN_LOCAL_DEMO=1`, `NEXT_PUBLIC_LOCAL_DEMO=1`
- Produces:
  - no global-catalog, prefix-floor, telemetry, or Speed Insights calls in local-demo mode;
  - no correction recheck, catalog-dispute request, Firebase Admin access, or Google font fetch;
  - no reconcile, share, import-mapping, catalog-review, account, or other cloud API access;
  - a local-demo API allowlist enforced before disallowed route logic;
  - inert local-demo API responses before storage/rate-limit access;
  - a sanitized server-egress ledger exposed only on localhost in explicit local-demo mode;
  - persistent visible `Local tire demo / External lookup off` banner and Report navigation.

- [ ] **Step 1: Add failing store/client egress tests**

With `NEXT_PUBLIC_LOCAL_DEMO=1` and inherited
`NEXT_PUBLIC_CLOUD_CATALOG=1`, submit an unresolved scan and assert:

```ts
expect(globalCatalogLookup).not.toHaveBeenCalled();
expect(prefixFloorEnrich).not.toHaveBeenCalled();
expect(postTelemetry).not.toHaveBeenCalled();
expect(store.getState().scanFeed).toHaveLength(1);
expect(store.getState().finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(1);
```

Call `markWrong()` in local-demo mode and assert the local quantity transfer succeeds while:

```ts
expect(correctionRecheck).not.toHaveBeenCalled();
expect(catalogDisputeFetch).not.toHaveBeenCalled();
expect(getAdminDb).not.toHaveBeenCalled();
expect(ladderStorage).not.toHaveBeenCalled();
```

`postTelemetry()` must also be tested directly with `fetch` stubbed and required to return without a
request in local-demo mode.

- [ ] **Step 2: Add failing inert-route tests**

For `/api/prefix-floor`, `/api/telemetry`, `/api/catalog-dispute`, `/api/reconcile/match`,
`/api/import-mapping`, `/api/share`, `/api/share/[token]`, and both catalog-review routes, set
`SCANBIN_LOCAL_DEMO=1` and assert the handler returns before rate limiting/storage/Firebase:

```ts
expect(checkRateLimit).not.toHaveBeenCalled();
expect(ladderStorage).not.toHaveBeenCalled();
expect(getAdminDb).not.toHaveBeenCalled();
```

The prefix route returns `Response.json(null)`. The telemetry and catalog-dispute routes return
status 204. Unsupported manager/cloud routes return a static 409 JSON response:
`{ error: "Unavailable in local tire demo", localDemo: true }`.

Add `src/proxy.ts` with a local-demo API allowlist containing only `/api/ai-lookup`,
`/api/local-demo/status`, and `/api/local-demo/manifest/<01-30>`. In explicit local-demo mode it must
return the same 409 response for every other `/api/*` path before route dispatch. Outside local-demo
mode it must be a pass-through. Follow
the checked-in Next 16 proxy documentation before implementation and add direct unit tests for
allowed, blocked, and non-demo behavior.

- [ ] **Step 3: Add failing Speed Insights and presentation tests**

Render with `NEXT_PUBLIC_LOCAL_DEMO=1` and assert:

```ts
expect(speedInsightsSdk).not.toHaveBeenCalled();
expect(nextFontGoogle).not.toHaveBeenCalled();
expect(screen.getByText("Local tire demo")).toBeVisible();
expect(screen.getByText("External lookup off")).toBeVisible();
expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/report");
expect(screen.queryByRole("link", { name: "Reconcile" })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: /share/i })).not.toBeInTheDocument();
expect(screen.getByText(/file import is unavailable in the certified local demo/i)).toBeVisible();
```

- [ ] **Step 4: Run all Task 3 tests and verify the expected failures**

Run:

```powershell
npx.cmd vitest run src/stores/localDemoEgress.store.test.ts src/lib/telemetry.test.ts src/app/api/telemetry/route.test.ts src/app/api/prefix-floor/route.test.ts src/app/api/catalog-dispute/route.test.ts src/proxy.localDemo.test.ts src/app/api/reconcile/match/route.test.ts src/app/api/import-mapping/route.test.ts src/app/api/share/route.test.ts src/app/api/share/[token]/route.test.ts src/app/api/catalog-review/route.test.ts src/app/api/catalog-review/[id]/route.test.ts src/app/layout.localDemo.test.tsx src/components/SpeedInsightsTelemetry.test.tsx src/components/ProdFirebaseBanner.test.tsx src/components/Nav.localDemo.test.tsx src/components/UniversalImportPanelContainer.test.tsx src/app/(app)/report/reportShare.test.tsx
```

Expected: local-demo egress guards, banner copy, and Report navigation are absent.

- [ ] **Step 5: Implement client and endpoint guards**

- In `scanStore.ts`, force global-catalog eligibility false and skip `enrichPrefixFloor()` when
  `NEXT_PUBLIC_LOCAL_DEMO === "1"`.
- In `markWrong()`, preserve the existing local quantity transfer but skip `correctionRecheck` and
  catalog-dispute scheduling in local-demo mode.
- In `postTelemetry()`, return before `fetch()` for the public local-demo flag.
- In all three API routes, return the inert response before rate limiting, storage, Firebase, or
  logging when
  `isLocalDemo()` is true.
- Apply the same first-executable-line rule to reconcile, import-mapping, share/read-share, and both
  catalog-review handlers. Their local-demo tests must spy on `ladderStorage`, Turso client creation,
  retail lookup, `getAdminDb`, and durable writes as applicable and require every count to remain
  zero.
- In `src/proxy.ts`, enforce the two-route local-demo API allowlist as a defense-in-depth boundary;
  no unsupported API route may be reachable from Chrome even if a UI guard regresses.
- Keep the normal production/mock/emulator behavior byte-identical when the flag is absent.

- [ ] **Step 6: Suppress Speed Insights and expose the local state**

- `SpeedInsightsTelemetry` returns `null` before rendering the SDK in local-demo builds.
- Remove the static `next/font/google` import from `layout.tsx`; use the existing local system-font
  stack in `globals.css` for sans and `Cascadia Code, Consolas, monospace` for mono. This removes
  Google font fetching in every build without changing body typography.
- `ProdFirebaseBanner` renders a persistent green local-demo banner without changing the existing
  production Firebase warning.
- Add Report to the main navigation using the existing link pattern and preserve the existing
  minimum 44px tap target.
- Hide Reconcile navigation, the report Share action, and the cloud-backed Universal Import panel
  in local-demo mode. Replace each with concise local-demo copy where context would otherwise be
  confusing; preserve local CSV/export and local review/correction workflows.

- [ ] **Step 7: Expose the sanitized server-egress ledger**

`GET /api/local-demo/status` exists only when both explicit local-demo mode and a loopback request
host are present. It returns the database hash, local mode flags, and the egress guard's sanitized
run-scoped file ledger/counter aggregated across all child PIDs. It never returns environment
variables, headers, tokens, query strings, or bodies. Outside local demo it returns 404. Tests must
seed a canary blocked attempt from a separate child process and prove the route sees it while
exposing only the sanitized target.

`GET /api/local-demo/manifest/[batch]` has the same local-demo/loopback gate. It reads only the
ignored, generator-owned `reports/local-tire-demo/active-run.json`, resolves paths under that report
root (never a request-controlled path), loads batch 01-30, recomputes all three batch hashes, and
returns the sanitized immutable batch header plus expected rows. Missing, malformed, traversal,
stale-database-hash, or hash-mismatched data fails closed.

- [ ] **Step 8: Verify Task 3**

Run:

```powershell
npx.cmd vitest run src/stores/localDemoEgress.store.test.ts src/lib/telemetry.test.ts src/app/api/telemetry/route.test.ts src/app/api/prefix-floor/route.test.ts src/app/api/catalog-dispute/route.test.ts src/proxy.localDemo.test.ts src/app/api/reconcile/match/route.test.ts src/app/api/import-mapping/route.test.ts src/app/api/share/route.test.ts src/app/api/share/[token]/route.test.ts src/app/api/catalog-review/route.test.ts src/app/api/catalog-review/[id]/route.test.ts src/app/api/local-demo/status/route.test.ts src/app/layout.localDemo.test.tsx src/components/SpeedInsightsTelemetry.test.tsx src/components/ProdFirebaseBanner.test.tsx src/components/Nav.localDemo.test.tsx src/components/UniversalImportPanelContainer.test.tsx src/app/(app)/report/reportShare.test.tsx
npx.cmd vitest run src/app/api/local-demo/manifest/[batch]/route.test.ts
npx.cmd eslint src/stores/scanStore.ts src/lib/telemetry.ts src/proxy.ts src/app/api/telemetry/route.ts src/app/api/prefix-floor/route.ts src/app/api/catalog-dispute/route.ts src/app/api/reconcile/match/route.ts src/app/api/import-mapping/route.ts src/app/api/share/route.ts src/app/api/share/[token]/route.ts src/app/api/catalog-review/route.ts src/app/api/catalog-review/[id]/route.ts src/app/api/local-demo/status/route.ts src/app/api/local-demo/manifest/[batch]/route.ts src/app/layout.tsx src/components/SpeedInsightsTelemetry.tsx src/components/ProdFirebaseBanner.tsx src/components/Nav.tsx src/components/UniversalImportPanelContainer.tsx src/app/(app)/report/page.tsx
```

Expected: all commands exit 0, every egress spy is zero, and the physical unresolved scan is visible
and counted once.

- [ ] **Step 9: Prove the local build needs no external network**

Run the build through `demo:local`'s preloaded process-wide egress guard, with the safe environment
builder active and every provider key set to its empty sentinel. Require `next build` to exit 0 and
the guard ledger to contain zero blocked attempts. The deliberate canary test from Task 1 must fail
closed in the same environment, proving the guard is active. This is a cold-build egress denial
check, not a deployment.

---

### Task 4: Generate the deterministic 3,000-tire manifest

**Files:**
- Create: `scripts/tire-demo-proof/sample.mjs`
- Create: `scripts/tire-demo-proof/sample.test.mjs`
- Create: `scripts/tire-demo-proof/generate-manifest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: read-only `src/server/knowledge.generated.db`, git revision
- Produces:

```ts
type TireProofRow = {
  ordinal: number;
  agent: number;
  batch: number;
  barcode: string;
  barcodeType: string;
  canonicalProductUid: string;
  brand: string;
  model: string;
  size: string;
  loadIndex: string;
  speedRating: string;
  manufacturerPartNumber: string;
  type: string;
  season: string;
  sourceCount: number;
  confidence: string;
  currentStatus: string;
  usableFor: string;
  fieldCompletenessScore: number;
  angle: "mpn_topology" | "winter_all_terrain" | "special_size_forms"
    | "source_5plus" | "verified_strong" | "lower_completeness"
    | "source_3" | "ean" | "upc" | "diversity_holdout";
  stratum: string;
};

type TireProofManifest = {
  schemaVersion: 1;
  seed: "scanbin-local-tire-demo-v1";
  gitSha: string;
  databaseSha256: string;
  generatedAt: string;
  total: 3000;
  batchSize: 100;
  batchCount: 30;
  agentCount: 10;
  manifestSha256: string;
  rows: TireProofRow[];
};
```

- [ ] **Step 1: Write failing pure sampler tests**

Use an in-memory fixture containing UPC, EAN, GTIN-14, duplicate canonical IDs, padding-equivalent
barcodes, multiple brands, and missing optional fields. Assert:

- identical seed/input produces byte-identical row order;
- different seed changes order;
- output contains unique barcodes;
- one canonical ID appears at most once;
- padding-equivalent keys cannot both appear;
- assignments are agents 1-10, three batches per agent, 100 rows per batch;
- `mapDatabaseRow()` converts every snake-case DB column to the camel-case manifest contract;
- every selected row satisfies the exact conservative eligibility predicate;
- all GTIN-14, review-candidate, source-count-zero/one, incomplete-identity, and invalid-checksum
  fixture rows are rejected;
- each agent receives exactly the required 300-row angle and every declared sub-quota is satisfied;
- fewer than 3,000 eligible rows throws a descriptive error.

- [ ] **Step 2: Verify sampler tests fail**

Run:

```powershell
node --test scripts/tire-demo-proof/sample.test.mjs
```

Expected: FAIL because the sampler does not exist.

- [ ] **Step 3: Implement the pure sampler**

Export the following checksum-valid equivalence helper and deterministic round-robin sampler:

```js
import { createHash } from "node:crypto";
import {
  isTrustedLocalDemoTireRow,
  isValidLocalDemoGtin as validGtin,
} from "../../src/server/tire-knowledge/localDemoTrust.mjs";

export function paddingEquivalenceKey(value) {
  const barcode = String(value ?? "").trim();
  if (!validGtin(barcode)) return barcode;
  if (barcode.length === 13 && barcode.startsWith("0") && validGtin(barcode.slice(1))) {
    return barcode.slice(1);
  }
  if (barcode.length === 14 && barcode.startsWith("00") && validGtin(barcode.slice(2))) {
    return barcode.slice(2);
  }
  return barcode;
}

export function mapDatabaseRow(row) {
  const rawCompleteness = Number(row.field_completeness_score || 0);
  return {
    barcode: String(row.barcode ?? "").trim(),
    barcodeType: String(row.barcode_type ?? ""),
    canonicalProductUid: String(row.canonical_product_uid ?? ""),
    brand: String(row.brand ?? ""),
    model: String(row.model_display || row.model || ""),
    size: String(row.size ?? ""),
    loadIndex: String(row.load_index ?? ""),
    speedRating: String(row.speed_rating ?? ""),
    manufacturerPartNumber: String(row.manufacturer_part_number ?? ""),
    type: String(row.type ?? ""),
    season: String(row.season ?? ""),
    sourceCount: Number(row.source_count || 0),
    confidence: String(row.confidence ?? ""),
    currentStatus: String(row.current_status ?? ""),
    usableFor: String(row.usable_for ?? ""),
    fieldCompletenessScore: rawCompleteness > 0 && rawCompleteness <= 1
      ? rawCompleteness * 100
      : rawCompleteness,
  };
}

function rank(seed, row) {
  return createHash("sha256")
    .update(`${seed}|${row.canonicalProductUid}|${row.barcode}`)
    .digest("hex");
}

function normalizedMpn(row) {
  return row.manufacturerPartNumber.replace(/[ -]/g, "").toUpperCase();
}

function barcodeShape(row) {
  return row.barcode.length === 12 ? "upc" : row.barcode.length === 13 ? "ean13" : "other";
}

export function sampleTireRows(
  rows,
  { seed, total = 3000, batchSize = 100, agentCount = 10 },
) {
  if (!seed) throw new Error("A non-empty deterministic seed is required.");
  const normalized = rows
    .filter(isTrustedLocalDemoTireRow)
    .map(mapDatabaseRow);
  const mpnFrequency = new Map();
  for (const row of normalized) {
    const mpn = normalizedMpn(row);
    if (mpn) mpnFrequency.set(mpn, (mpnFrequency.get(mpn) || 0) + 1);
  }

  const angleRules = [
    // Allocate the scarcest strata first so broad evidence/barcode groups cannot consume them.
    { angle: "mpn_topology", strata: [
      { stratum: "mpn_repeated", count: 250, test: (row) => { const key = normalizedMpn(row); return Boolean(key) && (mpnFrequency.get(key) || 0) > 1; } },
      { stratum: "mpn_unique", count: 50, test: (row) => { const key = normalizedMpn(row); return Boolean(key) && mpnFrequency.get(key) === 1; } },
    ] },
    { angle: "winter_all_terrain", strata: [
      { stratum: "winter_or_all_terrain", count: 300, test: (row) => /winter|all[ _-]?terrain/i.test(`${row.model} ${row.type} ${row.season}`) },
    ] },
    { angle: "special_size_forms", strata: [
      { stratum: "size_lt_or_flotation", count: 300, test: (row) => /^LT/i.test(row.size) || /^\d{2,3}(?:\.\d+)?X/i.test(row.size) },
    ] },
    { angle: "source_5plus", strata: [
      { stratum: "source_count_5plus", count: 300, test: (row) => row.sourceCount >= 5 },
    ] },
    { angle: "verified_strong", strata: [
      { stratum: "verified_1src_strong", count: 300, test: (row) => row.confidence === "verified_1src_strong" },
    ] },
    { angle: "lower_completeness", strata: [
      { stratum: "completeness_70_or_lower", count: 300, test: (row) => row.fieldCompletenessScore <= 70 },
    ] },
    { angle: "source_3", strata: [
      { stratum: "source_count_3", count: 300, test: (row) => row.sourceCount === 3 },
    ] },
    { angle: "ean", strata: [
      { stratum: "barcode_ean13", count: 300, test: (row) => barcodeShape(row) === "ean13" },
    ] },
    { angle: "upc", strata: [
      { stratum: "barcode_upc", count: 300, test: (row) => barcodeShape(row) === "upc" },
    ] },
    { angle: "diversity_holdout", strata: [
      { stratum: "remaining_brand_size_diversity", count: 300, test: () => true },
    ] },
  ];

  const usedBarcodes = new Set();
  const usedCanonicalIds = new Set();
  const usedEquivalenceKeys = new Set();
  const selected = [];
  for (const rule of angleRules) {
    for (const stratum of rule.strata) {
      const candidates = normalized
        .filter(stratum.test)
        .map((row) => ({ ...row, sampleRank: rank(seed, row) }))
        .sort((left, right) => left.sampleRank.localeCompare(right.sampleRank));
      let accepted = 0;
      for (const row of candidates) {
        const equivalenceKey = paddingEquivalenceKey(row.barcode);
        if (
          usedBarcodes.has(row.barcode)
          || usedCanonicalIds.has(row.canonicalProductUid)
          || usedEquivalenceKeys.has(equivalenceKey)
        ) continue;
        usedBarcodes.add(row.barcode);
        usedCanonicalIds.add(row.canonicalProductUid);
        usedEquivalenceKeys.add(equivalenceKey);
        selected.push({ ...row, angle: rule.angle, stratum: stratum.stratum });
        accepted += 1;
        if (accepted === stratum.count) break;
      }
      if (accepted !== stratum.count) {
        throw new Error(`Stratum ${stratum.stratum} requires ${stratum.count} rows; found ${accepted}.`);
      }
    }
  }
  if (selected.length !== total) {
    throw new Error(`Need ${total} eligible unique tire rows; found ${selected.length}.`);
  }
  const batchesPerAgent = total / batchSize / agentCount;
  if (!Number.isInteger(batchesPerAgent)) {
    throw new Error("total must divide evenly across batchSize and agentCount.");
  }
  return selected.map(({ sampleRank, ...row }, index) => ({
    ...row,
    ordinal: index + 1,
    batch: Math.floor(index / batchSize) + 1,
    agent: Math.floor(index / (batchSize * batchesPerAgent)) + 1,
  }));
}
```

Use `node:crypto` SHA-256 for ranking. Reject non-GTIN shapes, missing canonical IDs, invalid
barcodes, duplicate canonical IDs, duplicate raw barcodes, padding-equivalent duplicates, any
row outside the conservative predicate, and every GTIN-14 row. The pinned database was measured
at 4,873 eligible rows (2,343 UPC and 2,530 EAN); all ten sequential 300-row withdrawals above
were replayed successfully with the exact seed, hash rank, canonical-ID uniqueness, and padding
equivalence constraints. The generator must rerun that feasibility check and fail closed if corpus
drift makes any group infeasible.

- [ ] **Step 4: Implement the manifest generator**

Open the database with:

```js
new Database(databasePath, { readonly: true, fileMustExist: true });
```

Never issue INSERT/UPDATE/DELETE/DDL. Query the `tires` table, generate the manifest, create
`reports/local-tire-demo/<git-sha>-<db-hash>/batches`, and write:

```text
manifest.json
batches/batch-01.json
...
batches/batch-30.json
../active-run.json
```

Each batch file contains exactly 100 rows. Reopen every output file, parse it, and validate counts
before exiting 0. Call `assertLocalDemoDatabase()` first and require its database SHA-256/count to
match the opened file. Validate the exact ten angle totals and every sub-quota declared in
`angleRules`; do not silently substitute rows across strata.

Each batch must also contain `batchSha256`, `expectedBarcodesSha256`, and
`expectedCanonicalProductUidsSha256`, calculated over canonical JSON/ordered values. Recompute and
verify those hashes after reopening each output. They bind the later browser and ledger proof to one
exact 100-row input set.

Finally, atomically write ignored `reports/local-tire-demo/active-run.json` containing only schema
version, the validated run directory relative to `reports/local-tire-demo`, git/database hashes,
manifest hash, and generation time. Reject absolute/traversal paths. This pointer is the only bridge
the loopback manifest route may use; it never contains secrets or customer data.

Add:

```json
"demo:manifest": "node scripts/tire-demo-proof/generate-manifest.mjs"
```

- [ ] **Step 5: Verify Task 4**

Run:

```powershell
node --test scripts/tire-demo-proof/sample.test.mjs
npm.cmd run demo:manifest
```

Expected: 3,000 rows, 30 batches, 100 rows per batch, 10 agents, database SHA-256 printed, exit 0.

---

### Task 5: Add local proof-result validation and reporting

**Files:**
- Create: `scripts/tire-demo-proof/validate-result.mjs`
- Create: `scripts/tire-demo-proof/validate-result.test.mjs`
- Create: `scripts/tire-demo-proof/summarize.mjs`
- Create: `scripts/tire-demo-proof/summarize.test.mjs`
- Create: `src/services/reports/localDemoLedgerProof.ts`
- Create: `src/services/reports/localDemoLedgerProof.test.ts`
- Create: `src/components/LocalDemoLedgerProof.tsx`
- Create: `src/components/LocalDemoLedgerProof.test.tsx`
- Modify: `src/components/LiveScanFeed.tsx`
- Modify: `src/components/LiveScanFeed.test.tsx`
- Modify: `src/components/Nav.tsx`
- Modify: `src/app/(app)/report/page.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: locked batch JSON plus Chrome observation JSON
- Produces:

```ts
type ChromeObservation = {
  barcode: string;
  canonicalProductUid: string;
  eventId: string;
  matchedProductId: string;
  feedVisible: boolean;
  status: string;
  brand: string;
  model: string;
  size: string;
  latencyMs: number;
  consoleErrors: string[];
  nonLocalRequests: string[];
};

type LocalDemoLedgerProof = {
  schemaVersion: 1;
  manifest: {
    schemaVersion: 1;
    gitSha: string;
    databaseSha256: string;
    seed: string;
    batch: number;
    batchSha256: string;
    expectedBarcodesSha256: string;
    expectedCanonicalProductUidsSha256: string;
  };
  sessionId: string;
  generatedAt: string;
  expected: { rows: 100; barcodes: string[] };
  events: Array<{
    eventId: string;
    cleanCode: string;
    matchedProductId: string | null;
    canonicalProductUid: string | null;
    quantityDelta: number;
    quantityAfterScan: number;
    status: string;
    decodeStatus?: string;
  }>;
  finalCounts: Array<{ productId: string; quantity: number; scanEventIds: string[] }>;
  replayedCounts: Array<{ productId: string; quantity: number; scanEventIds: string[] }>;
  assertions: {
    allExpectedBarcodesSeenExactlyOnce: boolean;
    unexpectedBarcodeCount: number;
    duplicateEventIdCount: number;
    missingEventIdCount: number;
    unmatchedEventCount: number;
    finalEqualsReplay: boolean;
    countEventIdsEqualReplayEventIds: boolean;
    everyCountEventIdExistsInFeed: boolean;
    expectedQuantity: 100;
    finalQuantity: number;
    replayedQuantity: number;
    noDrops: boolean;
    noDuplicates: boolean;
    passed: boolean;
  };
};
```

and aggregate `summary.json` / `REPORT.md`.

- [ ] **Step 1: Write failing validator tests**

Tests must reject:

- missing/extra/duplicate barcodes;
- wrong brand, model, size, or verified status;
- wrong or missing local-demo `debug.canonicalProductUid`;
- invisible feed rows;
- missing/duplicate event IDs or missing matched product IDs;
- missing, malformed, or manifest/hash-mismatched ledger proof;
- any final-count quantity/event-ID membership mismatch against `replayLedgerCounts()`;
- any final/replayed event reference absent from the physical scan feed;
- non-local requests;
- console exceptions;
- fewer or more than 100 observations.

Tests must accept an exact 100-row result with optional blank fields preserved only when the
machine-readable ledger artifact independently proves 100 unique physical events, final quantity
100, replayed quantity 100, identical product/event-ID membership, and exact batch/hash binding.

- [ ] **Step 2: Verify validator tests fail**

Run:

```powershell
node --test scripts/tire-demo-proof/validate-result.test.mjs scripts/tire-demo-proof/summarize.test.mjs
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement validation**

Return:

```js
{
  passed: boolean,
  inputCount: 100,
  terminalCount: 100,
  correctVerified: number,
  wrongVerified: number,
  feedMissing: number,
  countedQuantity: number,
  consoleErrorCount: number,
  nonLocalRequestCount: number,
  p50Ms: number,
  p95Ms: number,
  p99Ms: number,
  failures: Array<{ barcode: string; rule: string; expected: unknown; observed: unknown }>,
}
```

Use nearest-rank percentiles and exact normalized string equality. Blanks never count as wrong unless
the manifest expected a non-empty value. `countedQuantity`, no-drop, and no-duplicate acceptance must
be recomputed from `LocalDemoLedgerProof`; never trust a Chrome-supplied per-row count delta.

- [ ] **Step 4: Implement the browser-observable ledger proof**

Build the artifact with a pure service that receives the locked batch header, ordered expected
barcodes/canonical IDs, current session ID, `scanFeed`, and `finalCounts`. It must call the existing
`replayLedgerCounts()` to reconstruct counts independently. Keep the app-local `matchedProductId`
separate from corpus `canonicalProductUid`; join the latter by exact expected barcode/local API debug
evidence, never infer it from the random app product ID.

Render the exact artifact JSON on Report in:

```html
<pre data-testid="local-demo-ledger-proof">...</pre>
```

with a concise visible pass/fail summary. It is present only in explicit public local-demo mode.
The batch number comes from an explicit validated `proofBatch=01..30` query parameter. The Report
component fetches only `/api/local-demo/manifest/<batch>`, recomputes all returned hashes in the
browser, and refuses to render a passing proof for a missing/malformed/mismatched batch. During
certification Chrome starts at `/scan?proofBatch=<NN>`; Nav preserves the validated parameter on its
Report link, making the active batch visible and stable for that session without browser-storage
introspection.

In local-demo mode only, each rendered `LiveScanFeed` row exposes
`data-local-demo-event-id` and `data-local-demo-matched-product-id` on the row. These values come
directly from the corresponding `ScanEvent`; outside explicit public local-demo mode the attributes
are absent. A component test verifies both modes. Chrome reads and saves these DOM identifiers plus
the exact Report JSON before resetting between batches. An optional download button may serialize
that same object, but must not create a second implementation.

Focused tests cover: exact 100-event pass; missing barcode; duplicate/blank event ID; extra barcode;
unmatched event; final/replay mismatch; count event absent from feed; manifest/hash mismatch; and
parseable component JSON with no non-loopback request. Route unavailable, malformed batch, invalid
query parameter, and hash mismatch must render an explicit failing proof, never an empty/partial pass.

- [ ] **Step 5: Implement aggregation**

`summarize.mjs` must refuse a green report unless all 30 valid result files exist. It must calculate
totals and thresholds from the design acceptance criteria and write both machine-readable JSON and a
human-readable Markdown matrix. Every result must carry one passing ledger proof plus a zero-attempt
server-egress ledger snapshot and Chrome network observation for its batch.

Add:

```json
"demo:proof:summary": "node scripts/tire-demo-proof/summarize.mjs"
```

- [ ] **Step 6: Verify Task 5**

Run:

```powershell
node --test scripts/tire-demo-proof/validate-result.test.mjs scripts/tire-demo-proof/summarize.test.mjs
npx.cmd vitest run src/services/reports/localDemoLedgerProof.test.ts src/components/LocalDemoLedgerProof.test.tsx src/components/LiveScanFeed.test.tsx src/components/Nav.localDemo.test.tsx
```

Expected: all commands exit 0.

---

### Task 6: Document and polish the manager walkthrough

**Files:**
- Create: `docs/LOCAL_MANAGER_DEMO.md`
- Modify only confirmed Chrome-blocking UI files discovered during Tasks 7-8

**Interfaces:**
- Consumes: `npm run demo:local`, manager demo routes and controls
- Produces: a reproducible ten-minute local presentation

- [ ] **Step 1: Write the walkthrough**

It must include:

1. exact start command and `http://localhost:3400/scan`;
2. visible confirmation that external lookup is off;
3. known tire scanned twice to show immediate quantity increment;
4. exact database tire with full brand/model/size;
5. derived invalid/near-match tire code that remains unidentified but counted;
6. correction/review flow proving quantity transfer;
7. local offline/retry feedback;
8. reload/history preservation;
9. Report navigation and local print view;
10. CSV export;
11. Settings reset before a real presentation;
12. explicit prohibition on `dev:prod`.

- [ ] **Step 2: Verify documentation anchors**

Run:

```powershell
rg -n "demo:local|localhost:3400|External lookup off|dev:prod|Report|export|reset" docs/LOCAL_MANAGER_DEMO.md
```

Expected: every required anchor appears.

---

### Task 7: Run ten-agent Chrome certification waves

**Files:**
- Read: `reports/local-tire-demo/<run>/batches/batch-*.json`
- Generate locally: `reports/local-tire-demo/<run>/results/batch-*.json`
- Generate locally: screenshots under `reports/local-tire-demo/<run>/screenshots/`

**Interfaces:**
- Consumes: running `http://localhost:3400`, one batch file, Chrome control
- Produces: one validated 100-row result per batch

- [ ] **Step 1: Start the local production demo**

Run:

```powershell
npm.cmd run demo:local
```

Confirm the server prints the local-only banner and serves `/scan`.

- [ ] **Step 2: Connect ChatGPT Chrome**

Select the Chrome extension surface explicitly, read its complete documentation, open
`http://localhost:3400/scan`, and confirm the visible local-demo banner.

- [ ] **Step 3: Rotate ten agents**

Use GPT-5.6 Terra at medium reasoning. Because the runtime has four total slots, run the coordinator
plus at most three workers and immediately reuse completed slots. Each agent must personally execute
three assigned batches through Chrome. Do not claim an agent is active after completion.

- [ ] **Step 4: Execute each 100-code batch**

For every code:

1. attach the Chrome extension's documented browser-network request/response observer before the
   first input; supplement it with Performance Resource Timing so fetch, XHR, image/script/font,
   beacon, navigation, and WebSocket-visible destinations are covered rather than monkeypatching
   `fetch` alone;
2. focus the real scanner input;
3. enter the barcode and submit using the scanner-supported path;
4. wait for terminal local-corpus or needs-review UI state;
5. collect the visible feed row, status, identity fields, event ID, matched app product ID, latency,
   and response `debug.canonicalProductUid`;
6. assert browser requests remain localhost-only;
7. append the observation to the agent's in-memory batch result.

After 100 inputs:

1. assert the run started at `/scan?proofBatch=<NN>`, the visible batch marker matches, and there are
   100 terminal observations;
2. open Report and parse the exact `data-testid="local-demo-ledger-proof"` JSON before reset;
3. fetch `/api/local-demo/status` from the loopback page and require a zero blocked-attempt server
   egress ledger;
4. validate Chrome observations plus ledger proof against the locked batch and all stored hashes;
5. capture a screenshot including the visible ledger pass state;
6. persist the validated result locally;
7. reset through the application UI before the next isolated batch unless the angle requires
   accumulated-session behavior.

- [ ] **Step 5: Cover the adversarial bonus set**

Use derived invalid-checksum, near-match, example/test, and conflict cases. Require no verified wrong
identity and counted quantity of one for every submission.

---

### Task 8: Fix, independently retest, and close the evidence loop

**Files:**
- Modify: only files implicated by confirmed Chrome failures
- Test: focused tests colocated with changed behavior
- Generate locally: final result/report artifacts

**Interfaces:**
- Consumes: Chrome failure packet
- Produces: focused fix, same-batch pass, independent verification, final 30-batch green report

- [ ] **Step 1: Triage every failure**

Classify each failure as product, proof-harness, or environment. Environment classification requires
evidence that the product behavior is correct after safe local artifact/configuration repair.

- [ ] **Step 2: Fix product defects**

For each product defect:

1. create a failing focused test when practical;
2. run it and record the expected failure;
3. implement the smallest root-cause fix;
4. rerun the focused test;
5. run focused ESLint/typecheck;
6. rebuild/restart localhost;
7. rerun the entire failed 100-code Chrome batch;
8. assign another agent to verify the same case.

- [ ] **Step 3: Re-run shared-risk gates**

After decoder, scanner-store, count, correction, or persistence changes, run:

```powershell
npm.cmd run test:ledger
npm.cmd run test:golden
npm.cmd run test:corpus-drift
npm.cmd run proof:local
```

Do not run Playwright/E2E.

- [ ] **Step 4: Re-run the complete Chrome proof**

After the last shared behavior fix, rerun all 30 batches. Generate `summary.json` and `REPORT.md`.

- [ ] **Step 5: Run the manager walkthrough twice**

Restart the local production demo from a clean process before each walkthrough. The second run must
not depend on state from the first.

- [ ] **Step 6: Adversarial review**

Dispatch lower-tier reviewers for:

- exact identity and GTIN safety;
- counting-law preservation;
- local-only egress/storage safety;
- performance and long-session stability;
- manager clarity and trust.

Fix every confirmed Critical or Important issue and rerun affected proof.

- [ ] **Step 7: Final local gates and commits**

Run:

```powershell
npx.cmd eslint <every remediation-changed source/test/script path>
npm.cmd run test:ledger
npm.cmd run test:golden
npm.cmd run test:corpus-drift
npm.cmd run proof:full
npm.cmd run demo:proof:summary
git status --short --branch
```

Create local commits with explicit paths only. Do not stage generated evidence, copied fixtures,
node_modules, or unrelated files. Do not push.

- [ ] **Step 8: Green report**

Report:

1. local branch and final HEAD;
2. local commits;
3. exact database SHA-256 and sampled count;
4. 30 batch results and ten agent roles;
5. Chrome metrics and screenshots;
6. defects found/fixed;
7. local verification commands/results;
8. remaining limitations;
9. `READY FOR MANAGER DEMO` or `NOT READY FOR MANAGER DEMO`.
