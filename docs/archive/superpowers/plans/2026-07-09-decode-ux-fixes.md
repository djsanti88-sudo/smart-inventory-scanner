# Decode Preview Fixes + Scan/Review UX Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken daily-cap counter, surface honest decode failures, show suggested identities (with confidence-aware labels) on the scan page, add a barcode column to Needs Review, prettify corpus product names, and backfill the 16 missing tire codes.

**Architecture:** Server fixes live in the ai-lookup route + an ATOMIC storage-backed cap counter charged inside the paid rung (reusing the existing ladder Turso storage). Client fixes are display-layer only (scanStore reason mapping, LiveScanFeed, NeedsReviewTable, FinalCountTable, ScannerInput) - no changes to decode decision logic or resolver trust rules. Corpus backfill is a data task via the existing upsert pipeline.

**Tech Stack:** Next.js 16 App Router, Zustand, Vitest (node + jsdom projects), Playwright, Turso/libsql, better-sqlite3.

**v2 changes (owner feedback 2026-07-09):** Task 0 added (preview access model P0); Task 1 hardened (atomic increment, charge inside the paid rung, read-only gate); Task 2 copy corrected (no false auto-retry promise); Task 5 grouped-token rule made explicit; Task 9 upsert criteria tightened.

## Context: why Needs Review shows 92% confidence

`decideDecode` (src/services/ai/decode.ts:303-319) multiplies every "suggested" result's confidence by 0.6, so a suggested row can never show above ~60%. Any review row showing 92% is a decode whose status was **verified** (confidence = max provider/cross-check confidence, decode.ts:281) but which a **store auto-count gate** refused to count: missing tire specs, non-public barcode shape, brand-prefix conflict, or `autoAddDecodedProducts` off. So 92% rows are "app verified the evidence, but a safety gate wants a human"; the UI just never says that. Task 4 makes the reason + barcode visible; Task 3 shows the identity on the scan page.

## Global Constraints

- No em dash or en dash in user-facing copy.
- `src/services` stays pure: no React / next/* imports.
- Automated tests NEVER call live providers (mock fetch / `page.route`; Playwright webServer runs `IS_E2E=1`).
- API keys server-side only; client never reads `process.env.*_API_KEY`.
- Resolver trust rules unchanged: AI results are suggestions; only human approval or the existing verified auto-count gate counts anything new.
- Do not deploy, push, or call paid/live APIs without owner approval. The backfill script (Task 9) hits paid rungs and is explicitly owner-gated.
- Branch: work on `feat/decode-ladder-goupc` (or a child branch); do not touch master.
- Known gotcha (project brain): `checkAndIncrementDaily` double-billing - exactly ONE cap charge per genuine paid compute; never charge on two paths of one request.

## Owner decisions locked in (from 2026-07-09 chat)

1. Suggested identities SHOW on the scan main page; the "(suggested)" tag appears only when confidence is truly low (threshold 0.8, same as decode).
2. Needs Review gets a barcode column visible to every role.
3. Unidentified-scan counting stays as designed ("These codes already count") - only its naming/labeling improves.
4. Backfill rule: wrong identity is worse than unknown - only complete, evidence-backed rows get upserted (Task 9).

---

### Task 0 (P0): Explain and lock the preview access model

Yesterday's handoff hit a real email/password sign-in on the preview; today `/` goes straight to `/scan` with open access. For a sellable preview that inconsistency cannot stay vague. Project memory says open access IS the current owner decision ("no login, no shop selection for now"), so this task is investigate + decide, NOT build auth.

**Files:**
- Read-only investigation: `git log --oneline -- src/app/sign-in src/app/login src/middleware.ts`, `vercel.json`, Vercel dashboard Deployment Protection settings (owner checks dashboard), the exact URL the previous session tested vs today's `https://inventory-8lnprljm7-sharpenly.vercel.app`.

- [ ] **Step 1:** Diff the two preview URLs/deployments from the handoff vs today; identify whether yesterday's login screen was (a) an older deployment with auth code, (b) Vercel Deployment Protection / SSO, or (c) an app route that still exists behind some flag. Record the answer with evidence (URL + screenshot).
- [ ] **Step 2:** Grep the repo for login/auth routes still reachable (`grep -rn "sign-in\|signIn\|password" src/app src/middleware.ts --include=*.tsx --include=*.ts -l`) and list what ships in the current build.
- [ ] **Step 3:** Owner decision checkpoint: open demo (current state), Vercel-protected preview (dashboard toggle, no code), or real login (future feature per memory). Write the decision into this plan and project memory. If protection is wanted, it is a Vercel dashboard action, not code - do it before the polish tasks ship to a shared preview.

---

### Task 1: Atomic, storage-backed daily cap counter charged inside the paid rung

The current counter (src/services/security/aiSpendGuard.ts:69-113) is a cwd JSON file + per-process memory: on Vercel it is per-instance, racy, and it increments even when rejecting (that is how it hit 232/200 while only ~27 paid calls happened). Requirements (v2, hardened):

1. **Atomic increment.** No read-then-set. On Turso/libsql: `INSERT INTO ladder_kv(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING CAST(value AS INTEGER)` (adapt table/column names to the actual ladderStorage schema; if the storage abstraction is get/set-only, ADD an `increment(key): Promise<number>` method implemented with the SQL above on Turso and a synchronous exclusive-lock file update locally).
2. **Charge inside the paid rung, not at the route gate.** The route gates (route.ts ~400 legacy, ~899 lazy decode) become READ-ONLY checks (`readDailyUsed >= limit` -> 429, no write). The single increment fires at the moment the FIRST paid provider call of the request actually starts (Go-UPC lookup, paid Fetch V2 stage, or GPT rung - whichever runs first), so free misses, blocked paths, and non-paid branches can never inflate the counter. Exactly one increment per request (double-billing gotcha).
3. **Expose the counter**: GET returns `daily: { used, limit }`.

**Files:**
- Modify: `src/services/security/aiSpendGuard.ts`
- Modify: the ladder storage module (add `increment` if missing - find via the `goUpcUsage`/`ladderStorage` imports in route.ts)
- Modify: `src/app/api/ai-lookup/route.ts` (gates ~400 and ~899 -> read-only check; GET ~252-321) and the computeDecode paid-rung entry point (charge site; find via `grep -n "goUpc\|gptLadder" src/app/api/ai-lookup/route.ts` and the ladder service it calls)
- Test: `src/services/security/aiSpendGuard.test.ts`

**Interfaces:**
- Produces: `readDailyUsed(storage, dateKey?): Promise<number>` (read-only, for gates + GET).
- Produces: `chargeDailySlot(storage, opts?: { limit?; dateKey? }): Promise<{ used: number; limit: number }>` - atomic increment via `storage.increment`, called ONLY at the first paid rung.
- Produces: `storage.increment(key: string): Promise<number>` on the ladder storage (atomic on Turso; exclusive-lock file locally).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { readDailyUsed, chargeDailySlot } from "./aiSpendGuard";

function memStorage() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async increment(k: string) { const n = Number(m.get(k) ?? "0") + 1; m.set(k, String(n)); return n; },
  };
}

describe("daily cap v2", () => {
  it("read-only check never writes", async () => {
    const s = memStorage();
    expect(await readDailyUsed(s, "2026-07-09")).toBe(0);
    expect(await readDailyUsed(s, "2026-07-09")).toBe(0); // still 0 - no phantom increments
  });

  it("charge increments exactly once per call", async () => {
    const s = memStorage();
    const r1 = await chargeDailySlot(s, { limit: 200, dateKey: "2026-07-09" });
    const r2 = await chargeDailySlot(s, { limit: 200, dateKey: "2026-07-09" });
    expect(r1.used).toBe(1);
    expect(r2.used).toBe(2);
  });

  it("20 concurrent charges land on exactly 20 (atomicity contract)", async () => {
    const s = memStorage();
    await Promise.all(Array.from({ length: 20 }, () => chargeDailySlot(s, { limit: 200, dateKey: "2026-07-09" })));
    expect(await readDailyUsed(s, "2026-07-09")).toBe(20);
  });

  it("resets on a new date key", async () => {
    const s = memStorage();
    await chargeDailySlot(s, { limit: 5, dateKey: "2026-07-08" });
    expect(await readDailyUsed(s, "2026-07-09")).toBe(0);
  });
});
```

Plus a storage-level test for the REAL `increment` against local sqlite (better-sqlite3 in-memory): 50 parallel increments -> value exactly 50.

- [ ] **Step 2: Run tests, verify they fail** - `npx vitest run src/services/security/aiSpendGuard.test.ts` -> FAIL.

- [ ] **Step 3: Implement**

```ts
const DAILY_KEY_PREFIX = "ai_daily_cap:";

type StorageLike = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  increment(k: string): Promise<number>;
};

export async function readDailyUsed(storage: StorageLike, dateKey = todayKey()): Promise<number> {
  const raw = await storage.get(DAILY_KEY_PREFIX + dateKey);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function chargeDailySlot(
  storage: StorageLike,
  opts: { limit?: number; dateKey?: string } = {},
): Promise<{ used: number; limit: number }> {
  const limit = opts.limit ?? Number(process.env.AI_LOOKUP_DAILY_LIMIT || 200);
  const used = await storage.increment(DAILY_KEY_PREFIX + (opts.dateKey ?? todayKey()));
  return { used, limit };
}
```

Ladder storage `increment` (Turso): single SQL statement `INSERT ... ON CONFLICT ... DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING ...` - one round trip, atomic. Local file fallback: read+write inside an exclusive lock (or better-sqlite3 UPDATE, whichever the local ladder storage already uses).

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Rewire the route**
  - Gates at ~400 and ~899: `const used = await readDailyUsed(await ladderStorage()); if (used >= limit) return 429 daily_cap` - NO write on this path.
  - Charge site: at the first paid provider call of the request (legacy path: right before its provider call; decode path: inside computeDecode immediately before the Go-UPC call, with a per-request `charged` flag so Fetch V2/GPT later in the same request do NOT charge again).
  - GET: add `daily: { used: await readDailyUsed(await ladderStorage()), limit }`.
  - Delete the old file-based `checkAndIncrementDaily` + `memDaily` once `grep -r checkAndIncrementDaily src/` is clean.

- [ ] **Step 6: Route-level tests** - extend the existing cap tests (`grep -rl "daily_cap" src/`): (a) cap exhausted -> 429 daily_cap and `used` UNCHANGED after 3 more blocked POSTs; (b) corpus-hit decode -> `used` unchanged; (c) paid-ladder decode (mocked providers) -> `used` +1 exactly, even when Go-UPC misses and GPT also runs.

- [ ] **Step 7: Commit** - `git add -A; git commit -m "fix(cap): atomic daily counter charged inside the paid rung; gates are read-only; GET exposes daily.used"`

**Note for the owner:** no reset endpoint (an unauthenticated reset on an open-access app would let anyone clear your spend guard). Resetting = one-line script writing the storage key. Say the word if you want a gated admin route instead.

---

### Task 2: Honest daily-cap copy on the client + no pointless retry

scanStore's `decodeOnce` (src/stores/scanStore.ts:1919-1937) retries every 429 once and never reads `reasonCode`, then wraps everything as "Live decode failed (network / rate-limit / provider error)" (scanStore.ts:2376-2378). A daily-cap 429 must not retry and must say what happened. v2: there is NO automatic decode-on-cap-reset queue in the app (only the sync retry queue and the manual "Retry live decode" button), so the copy must not promise one.

**Files:**
- Modify: `src/stores/scanStore.ts` (~1919-1937 and ~2376-2378)
- Test: `src/stores/scanStore.decodeCap.test.ts` (new; follow the store-test conventions in e.g. `cloudDrainRace.store.test.ts`)

**Interfaces:**
- Produces: error class `DailyCapReachedError extends Error` with `reasonCode = "daily_cap"`, thrown by `decodeOnce`; feed reason copy: `"Daily AI lookup cap reached. This scan is saved and counted as unverified. Retry after the cap resets."`

- [ ] **Step 0: Verify the no-auto-retry claim** - `grep -rn "daily_cap\|capReset\|retryQueue" src/stores src/services` and confirm nothing re-decodes automatically on cap reset. If a queue DOES exist, keep this copy but append "or it will retry automatically." (evidence decides the copy).

- [ ] **Step 1: Write the failing test**

```ts
it("daily_cap 429: no retry, honest reason", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "Daily AI lookup cap reached (200/200). No AI call made.", reasonCode: "daily_cap" }), { status: 429 });
  }));
  await useScanStore.getState().processScan("086699998538");
  await vi.waitFor(() => {
    const r = useScanStore.getState().needsReviewQueue.find((q) => q.cleanCode === "086699998538");
    expect(r?.reason).toContain("Daily AI lookup cap reached");
    expect(r?.reason).toContain("Retry after the cap resets");
    expect(r?.reason).not.toContain("provider error");
  });
  expect(calls.filter((u) => u.includes("/api/ai-lookup")).length).toBe(1);
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement** in `decodeOnce`:

```ts
if (res.status === 429) {
  const body = await res.json().catch(() => ({} as { reasonCode?: string }));
  if (body?.reasonCode === "daily_cap") throw new DailyCapReachedError();
  // real rate limit: keep the single Retry-After retry exactly as today
  // ...existing retry code...
}
```

and in the catch that builds `failReason` (~2376):

```ts
const failReason = e instanceof DailyCapReachedError
  ? "Daily AI lookup cap reached. This scan is saved and counted as unverified. Retry after the cap resets."
  : `Live decode failed (network / rate-limit / provider error). Counted as unverified; retry to identify. ${e instanceof Error ? e.message : ""}`.trim();
```

- [ ] **Step 4: Run the test file + full `npm run test`** -> PASS.
- [ ] **Step 5: Commit** - `git commit -am "fix(scan): daily_cap 429 gets honest copy and no retry"`

---

### Task 3: Scan page shows the suggested identity; "(suggested)" tag only when truly low confidence

Bug: `LiveScanFeed.tsx:56` does `const suggestion = product ? undefined : needsReviewQueue.find(...)` - but `ensureProvisionalCount` (scanStore.ts:2446) ALWAYS creates a provisional placeholder product first, so `product` is truthy and the suggestion lookup is skipped: the feed shows "Unidentified item (barcode X)" forever even when the decode produced a 92% identity. Owner rule: always show the best-known identity on the scan page; append the "(suggested)" tag only when confidence < 0.8.

**Files:**
- Modify: `src/components/LiveScanFeed.tsx` (~50-98)
- Test: `src/components/LiveScanFeed.test.tsx` (jsdom project; follow existing component test conventions)

**Interfaces:**
- Consumes: `Product.provisional: boolean` (set by ensureProvisionalCount, scanStore.ts:2467-2472) and `UnknownCodeReview.{cleanCode,suggestedProductName,suggestedBrand,confidence,decodeStatus}` (types.ts:214-288).
- Produces: feed Product cell shows, in priority order: real product name -> suggestion name -> provisional placeholder -> "-". Tag rules: confidence >= 0.8 -> small neutral tag "unconfirmed"; confidence < 0.8 -> amber "(suggested)". (An unconfirmed high-confidence identity must stay visually distinct from a Verified match - resolver trust rules.)

- [ ] **Step 1: Write the failing test**

```tsx
it("shows the suggested identity instead of the Unidentified placeholder", () => {
  // store state: provisional product "Unidentified item (barcode 086699...)" + review item
  // with suggestedProductName "Michelin Defender LTX M/S 275/60R20", confidence 0.92
  render(<LiveScanFeed />);
  expect(screen.getByText(/Michelin Defender LTX/)).toBeInTheDocument();
  expect(screen.queryByText(/Unidentified item/)).not.toBeInTheDocument();
  expect(screen.getByText(/unconfirmed/i)).toBeInTheDocument();
  expect(screen.queryByText(/\(suggested\)/)).not.toBeInTheDocument();
});
it("low-confidence suggestion keeps the (suggested) tag", () => {
  // same setup with confidence 0.55
  render(<LiveScanFeed />);
  expect(screen.getByText(/\(suggested\)/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** in LiveScanFeed row logic:

```tsx
const suggestion = (!product || product.provisional)
  ? needsReviewQueue.find((r) => r.cleanCode === e.cleanCode && r.suggestedProductName)
  : undefined;
const displayName = (product && !product.provisional ? product.name : undefined)
  ?? suggestion?.suggestedProductName
  ?? product?.name /* provisional placeholder as last resort */
  ?? "-";
const tag = suggestion
  ? (suggestion.confidence >= 0.8 ? "unconfirmed" : "(suggested)")
  : null;
```

Render `tag` with amber styling for "(suggested)" and neutral gray for "unconfirmed". Apply the same suggestion-first fallback to the SKU cell (line ~79).

- [ ] **Step 4: Run tests -> PASS. Also run the jsdom project via `npm run test`.**
- [ ] **Step 5: Commit** - `git commit -am "feat(scan): feed shows suggested identity; (suggested) tag only under 0.8 confidence"`

---

### Task 4: Barcode column on the Needs Review page (all roles)

NeedsReviewTable (src/components/NeedsReviewTable.tsx:57-67) hides Raw code / Normalised barcode behind platformOwner; customers see rows with no code at all. `cleanCode` and `rawCode` already exist on `UnknownCodeReview` (types.ts:218-219) - this is purely a column add.

**Files:**
- Modify: `src/components/NeedsReviewTable.tsx` (header ~57-67, row ~86-421)
- Test: `src/components/NeedsReviewTable.test.tsx` (extend existing if present, else create)

- [ ] **Step 1: Failing test** - render the table as a NON-platformOwner role with a review item `cleanCode: "086699998538"`; assert `screen.getByText("086699998538")` and a "Barcode" column header.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** - add `<th>Barcode</th>` right before Reason for all roles, and in ReviewRow: `<td className="px-4 py-3 font-mono text-sm">{review.cleanCode || review.rawCode || "-"}</td>`. Keep the platformOwner-only Raw/Normalised columns as-is.
- [ ] **Step 4: Run tests -> PASS.**
- [ ] **Step 5: Commit** - `git commit -am "feat(review): barcode column visible to all roles"`

---

### Task 5: Prettify slug product names at display time

Corpus rows store model slugs (`wrangler_workhorse_at`) and lowercase brands; TireKnowledgeProvider (src/server/tire-knowledge/TireKnowledgeProvider.ts:26-31) joins them raw, and no prettify helper exists anywhere. Fix at the DISPLAY boundary (pure helper + apply in provider result construction) so stored/normalized matching fields stay untouched.

**v2 implementation trap (explicit):** naive per-token mapping breaks `energy_saver_a_s` and `eagle_f1_asymmetric_a_s`. The algorithm MUST merge grouped letter-pair patterns BEFORE per-token casing: scan the underscore-token list left to right; when two consecutive single-letter tokens form a known pair (`["a","s"] -> "A/S"`, `["m","s"] -> "M/S"`), consume both and emit the merged token; only then apply the per-token map / Title Case to the remainder.

**Files:**
- Create: `src/services/format/productDisplay.ts`
- Test: `src/services/format/productDisplay.test.ts`
- Modify: `src/server/tire-knowledge/TireKnowledgeProvider.ts:26-31` (use helper for productName + brand)
- Modify: `src/components/LiveScanFeed.tsx`, `src/components/FinalCountTable.tsx:160`, `src/components/NeedsReviewTable.tsx` (product dropdown labels) - wrap displayed names.

**Interfaces:**
- Produces: `prettifyProductName(input: string): string` and `prettifyBrand(input: string): string` (pure, no React imports).

- [ ] **Step 1: Failing tests**

```ts
expect(prettifyProductName("wrangler_workhorse_at")).toBe("Wrangler Workhorse AT");
expect(prettifyProductName("energy_saver_a_s")).toBe("Energy Saver A/S");
expect(prettifyProductName("eagle_f1_asymmetric_a_s")).toBe("Eagle F1 Asymmetric A/S");
expect(prettifyProductName("defender_ltx_m_s")).toBe("Defender LTX M/S");
expect(prettifyProductName("cs5_ultra_touring")).toBe("CS5 Ultra Touring");
expect(prettifyProductName("eagle_sport_all-season")).toBe("Eagle Sport All-Season");
expect(prettifyBrand("goodyear")).toBe("Goodyear");
expect(prettifyBrand("bfgoodrich")).toBe("BFGoodrich");
// already-clean input passes through untouched:
expect(prettifyProductName("Michelin Premier A/S 215/60R16 95H")).toBe("Michelin Premier A/S 215/60R16 95H");
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** - algorithm order: (1) pass-through guard: no `_` AND contains an uppercase letter -> return unchanged; (2) split on `_`; (3) merge letter-pair groups (a+s -> A/S, m+s -> M/S) left to right; (4) per-token map (at->AT, ht->HT, ltx->LTX, f1->F1, digit-led like cs5->CS5 uppercase) else Title Case (hyphenated tokens title-case each part); (5) join with spaces. Brand map for multi-cap brands (bfgoodrich->BFGoodrich, goodyear->Goodyear, michelin->Michelin, cooper->Cooper, firestone->Firestone, bridgestone->Bridgestone, default Title Case).
- [ ] **Step 4: Run tests -> PASS.**
- [ ] **Step 5: Apply at the three display sites + provider** - TireKnowledgeProvider: `const name = [prettifyBrand(row.brand), prettifyProductName(row.model), specs]...`; components wrap their displayName values. Add one component-level assertion per site (feed shows "Wrangler Workhorse AT"). Run `npm run test`.
- [ ] **Step 6: Commit** - `git commit -am "feat(display): prettify slug product names and brands"`

**Deliberately NOT in scope:** rewriting stored corpus rows (78k rows on Turso). Display-layer fix covers every consumer; a corpus normalization migration is a separate owner-gated data task.

---

### Task 6: Counts table Size column shows the real size, not the digit-mash

FinalCountTable (src/components/FinalCountTable.tsx:165-166) fills Size with `product.sizeTag || plainTireSizeDigits(product.specsShort)` -> "2457016" while Specs already shows "245/70R16 107T". Show the canonical size ("245/70R16"); keep the digit-mash only as a `title` attribute (it is the scannable sidewall form some owners search by).

**Files:**
- Modify: `src/components/FinalCountTable.tsx` (~164-166)
- Test: extend `src/components/FinalCountTable.test.tsx`

- [ ] **Step 1: Failing test** - product with `specsShort: "245/70R16 107T"`; assert the Size cell renders "245/70R16" and NOT "2457016".
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** - `const sizeDisplay = matchTireSize(product.specsShort)?.canonical.split(" ")[0] ?? product.sizeTag ?? "-";` render `<td title={resolvedSizeTag(product)}>{sizeDisplay}</td>`. Confirm the filter box (which matches "205" style queries) still filters on BOTH forms - check the filter predicate and include both fields if it only used one.
- [ ] **Step 4: Run tests -> PASS.**
- [ ] **Step 5: Commit** - `git commit -am "fix(counts): Size column shows canonical size, digit form moves to tooltip"`

---

### Task 7: Scanner status line returns to Ready

ScannerInput (src/components/ScannerInput.tsx:121-195) keeps `lastResult` forever, so "Looking up this product..." (or the last amber panel) sticks until the next scan. Reset to Ready 5 seconds after a scan reaches a terminal state; keep showing the panel while `decodeStatus === "decoding"`.

**Files:**
- Modify: `src/components/ScannerInput.tsx`
- Test: extend `src/components/ScannerInput.test.tsx` (fake timers)

- [ ] **Step 1: Failing test** - with fake timers: set a scan whose decode completes (store event updates to `decodeStatus: "verified"`); advance 5s; expect "Ready to scan." visible again. Second case: while `decodeStatus === "decoding"`, advancing 5s does NOT reset.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** - `useEffect` keyed on the feed entry for `lastResult?.id`: when its `decodeStatus` is terminal (`verified | suggested | conflict | needs_review | undefined`) start a 5s timeout that does `setLastResult(null)`; clear the timeout on new scan/unmount.
- [ ] **Step 4: Run tests -> PASS.**
- [ ] **Step 5: Commit** - `git commit -am "fix(scan): status line resets to Ready after decode settles"`

---

### Task 8: Status endpoint tells the truth about the decode ladder

GET /api/ai-lookup (route.ts:252-321) still advertises geminiEnabled/geminiConfigured/geminiModel although Gemini is permanently out of decode; Settings renders it and the client gate `refreshAiStatus` (scanStore.ts:1566-1604) keys autoDecode on `geminiConfigured || openaiConfigured`. Do NOT remove fields (removal breaks Settings at ~line 147; renames silently disable autoDecode). Add honest fields; adjust display copy.

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts` (GET)
- Modify: `src/types.ts` (AiStatus type), `src/stores/scanStore.ts` (refreshAiStatus), Settings component rendering provider status (find via `grep -rn "geminiConfigured" src/app src/components`)
- Test: extend the route GET test + a Settings render test

- [ ] **Step 1: Failing route test** - GET response includes `decodeLadder: ["corpus", "go_upc", "fetch_v2", "gpt"]`, `daily: { used, limit }` (from Task 1), and `geminiUsedForDecode: false`.
- [ ] **Step 2: Implement** - add those fields to the GET JSON (keep every existing field). In Settings, label the Gemini row "Gemini: not used for decode (enrichment only)" using `geminiUsedForDecode`.
- [ ] **Step 3: Run route + component tests -> PASS. Run `npm run lint`.**
- [ ] **Step 4: Commit** - `git commit -am "feat(status): expose decode ladder + daily counter; label Gemini as not used for decode"`

---

### Task 9 (OWNER-GATED, paid): backfill the 16 missing tire codes into the corpus

The 16 codes (13 Michelin, 3 Goodyear) are absent from BOTH local SQLite and Turso - a harvest gap. After Task 1 deploys (cap counter sane), decode them once through the paid ladder and upsert the results, so they become $0 corpus hits forever. Estimated worst case: 16 Go-UPC units + up to 16 GPT ladder calls (ladder cap $3/day applies). **Do not run without owner OK.**

**v2 upsert criteria (strict - wrong identity is worse than unknown):** a row is upserted ONLY if it has ALL of: barcode, brand, model, tire size, load index, speed rating, at least one source URL, AND app-verified exact-code evidence (`exactCodeEvidenceVerifiedByApp === true`). Anything weaker stays out and is documented as a permanent gap in the review JSON. No exceptions, no "close enough" rows.

**Files:**
- Create: `scripts/backfill-missing-tires.mjs` (model the decode POST on `scripts/dt-harvest/state/test-preview-200.mjs`; reuse the dt-harvest apply/upsert path for the Turso write, do not reimplement)
- The 16 codes: 697662160311 697662160328 697662133469 086699137685 086699165459 086699212016 086699300546 086699332844 086699339157 086699430304 086699431998 086699525222 086699778642 086699855275 086699979674 086699998538

- [ ] **Step 1: Write the script** - for each code: POST decode (local dev server with live keys, NOT preview); keep only rows meeting ALL v2 criteria above; write a review JSON of {code, brand, model, size, load, speed, sourceUrls, evidenceStrength, exactCodeEvidenceVerifiedByApp} WITHOUT upserting anything.
- [ ] **Step 2: Owner reviews the surviving identities** (expect fewer than 16; that is fine).
- [ ] **Step 3: Upsert approved rows** via the existing dt-harvest apply path to Turso + regenerate local `knowledge.generated.db`.
- [ ] **Step 4: Prove** - rerun the 100-code preview script; every upserted code must return `corpus_exact_barcode`; document the rest as gaps.
- [ ] **Step 5: Commit** the corpus delta per the dt-harvest pipeline's normal flow.

---

### Task 10: End-to-end proof gate (required before calling any of this done)

Per the project's Human Bot Proof Gate, resolution/scan changes need browser proof, not just unit tests.

- [ ] **Step 1:** `npm run test` (all Vitest projects) and `npm run lint` -> green.
- [ ] **Step 2:** `npm run test:e2e` -> green; add one e2e: scan a mocked suggested decode (page.route `/api/ai-lookup` with a 0.92-confidence suggested payload) -> feed shows the identity with "unconfirmed" tag, review page shows barcode column. Screenshot to `e2e/proof/`.
- [ ] **Step 3:** Run the relevant `npm run qa:bots:*` scan-flow bot; attach screenshots.
- [ ] **Step 4:** Deploy preview (owner-gated), rerun `scripts/dt-harvest/state/test-preview-200.mjs` + the 100-code script against it; verify `daily.used` in GET moves ONLY on paid-ladder decodes (scan 5 corpus hits -> unchanged; 1 miss -> +1).
- [ ] **Step 5:** Final report with proof artifacts; owner reviews before any merge/promote.

---

## Task order & dependencies

- 0 (access model) first - it is an owner decision + dashboard toggle, independent of code.
- 1 (cap counter) -> 2 (cap copy). 2's test mocks the server so it can start in parallel, but ship together.
- 3, 4, 5, 6, 7, 8 are independent display fixes; any order.
- 9 requires 1 deployed to preview + owner approval (paid).
- 10 last.

## Self-review notes

- Spec coverage: access model (T0), atomic cap counter charged in paid rung (T1), honest 429 copy without false promises (T2), suggested identity on scan page + low-confidence-only tag (T3), review barcode column (T4), slug names with grouped-pair handling (T5), size digit-mash (T6), stale status line (T7), Gemini status honesty (T8), strict 16-code backfill (T9), bot/browser proof (T10). The 92% question is answered in Context.
- Unidentified-item counting policy intentionally unchanged (documented in Owner decisions).
- Line numbers are from the 2026-07-09 explorer pass on feat/decode-ladder-goupc; executors must re-verify with grep before editing.
