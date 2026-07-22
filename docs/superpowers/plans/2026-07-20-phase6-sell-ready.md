# Phase 6 - Sell-Ready Hardening & Launch Pack (2026-07-20)

**Goal:** Fix the three real pre-launch bugs (tenant-starving cap, stale-profile retention bug, D10
corpus drift), harden the ops surface (durable limits/guards, server-side error visibility), add the
minimum customer-facing launch surface (account section, first-run guidance, data portability), and
bring the docs to launch truth. Master plan: `2026-07-19-master-plan.md` P6 + D10/D11. Scout evidence
(exhaustive, file:line): `.superpowers/sdd/p6-scout.md`, `p6-corpus-scout.md`, `p6-ops-scout.md` -
implementers MUST read the relevant scout section before their task; anchors are NOT repeated here.

**Acceptance criteria:**
1. A tenant with remaining per-account budget is never 429'd because ANOTHER tenant (or anonymous
   demo traffic) drained the shared global cap; anonymous traffic still hits a global ceiling; L12
   (exactly one charge per genuine compute) intact - `npm run test:ledger` and the cap tests prove it.
2. `userProfiles.updatedAt`/`lastLoginAt` refreshes on EVERY login path incl. password sign-in.
3. Tire corpus manifest regenerated; meta/RAG-status/generated.json agree on ONE number; drift floor
   derived from the manifest at test-run time (never a hand-typed literal); `test:corpus-drift` runs
   creds-free in real gates; `docs/COMMANDS.md` no longer claims a live-Turso check. Fork DECIDED:
   option (a) local-manifest-floor (live-Turso count monitoring = separate future scope).
4. Rate limiting + the GPT $-guard survive multi-instance deploy (Turso-backed via LadderStorage);
   the file-only path remains only as the documented dev fallback.
5. Every API route's error/block/429/kill-switch site emits ONE structured server-side log line
   (owner-visible in Vercel logs); no third-party SDK (no new accounts - owner rule).
6. Settings shows "Signed in as {email}" + working Sign out; a first-run banner appears on /scan only
   when the feed is empty AND the business has never scanned - and NEVER steals scanner focus.
7. Account export (all tenant collections -> JSON/CSV bundle) and hard account deletion (tenant docs
   purged; `catalogEntries`/master stores UNTOUCHED - invariant #4) exist behind auth + re-confirm,
   with emulator rules tests.
8. README says Scanbin + the real 8-stage ladder. No em/en dash in any new copy.
9. TOP-LEVEL LAW + Resolver Trust Rules untouched. Full battery green at close + qa:bots proof
   (export/customer-facing changes) + slim ultra review + agy (Flash/medium) final pass.

## Global Constraints
- **GC-A (cap reorder is law-critical - design DECIDED, review F1/F2):** per-account check/charge
  FIRST when `authedBusinessId` exists; global cap becomes the anonymous gate + a high platform
  backstop (env `AI_LOOKUP_GLOBAL_BACKSTOP`, default `AI_LOOKUP_DAILY_LIMIT*10`).
  - Legacy path: literally INVERT the block order at route.ts:298-321 (account check before the
    global `used >= limit` check; authed traffic's global comparison uses the BACKSTOP value).
  - Decode path (option (b), decided): the route pre-check (:368-378) is the tenant gate; thread a
    `capContext: { authedBusinessId?: string; accountCapCleared: boolean }` param into
    `runDecodePipeline` so its internal global gate (pipeline.ts:1281-1284 -> cap_blocked :1561)
    compares against the BACKSTOP when `accountCapCleared` - it must never independently 429 an
    authed tenant under their own limit. Anonymous requests keep today's global gate unchanged.
  - L12 already structurally clean (review F3): `paidComputeCharged` + route.ts:419-420 is the
    single-charge design - A2's tests assert it stays true, reviewers need not re-derive it.
- **GC-B (no new accounts/SDKs):** no Sentry/PostHog/etc. signups. Server visibility = structured
  `console.error`/`console.warn` JSON lines (one tiny `src/server/log.ts` helper). Instrumentation =
  Firestore timestamp fields only (`signedUpAt`/`lastLoginAt`/`firstScanAt`), carrying ONLY
  businessId + timestamps - never codes/identities/prices (sanitization law).
- **GC-C (D10 discipline):** regenerate BEFORE touching the test; never hand-type a count; do not
  reconcile `coverage_ledger.json` (harvester-owned, different pipeline stage); build script is
  offline/$0/fail-closed - a lock-age failure is a retry, not a bug. Retail drift gate = OUT of scope.
- **GC-D (scanner focus):** no onboarding element may take focus or intercept keys; compose with the
  existing empty-state at LiveScanFeed.tsx:47; banner-not-modal.
- **GC-E (deletion safety):** delete route purges ONLY `businesses/{businessId}/*` + that business's
  memberships/profile rows + auditLog; NEVER `catalogEntries`/`retailCatalogEntries`/corpus files.
  Requires fresh re-auth confirmation server-side; UI in the existing Danger zone with PIN gate
  pattern. Export must succeed BEFORE delete is offered in the same UI flow (export-first nudge).
- **GC-F (legacy gate):** `checkAndIncrementDaily` is legacy (CLAUDE.md: no new callers). B1 confirms
  its live callers; if zero, delete it with its tests; if any, leave untouched and note.

## Tasks (tracks are disjoint-file parallel; sequence INSIDE a track only)
**Track A - bugs first**
- **A1 (trivial, do first):** `signInWithPassword` captures the credential + calls
  `ensureUserProfile(cred.user)` (auth.ts:50-57, mirror :61-62); `ensureUserProfile` also sets
  `lastLoginAt` + `signedUpAt`-once (merge semantics). Failing-first unit test (mock Firebase auth).
- **A2 (law-critical, dedicated review):** cap reorder per GC-A across route.ts:298-321 (legacy) and
  the decode-mode pre-check/pipeline `cap_blocked` gate (scout p6-ops #2 has the exact map). Tests
  (failing-first on the starvation case): an AUTHED tenant with acctUsed=0 succeeds on BOTH paths
  while the global counter is at/above AI_LOOKUP_DAILY_LIMIT (drained by another tenant/anon);
  anonymous still 429s at the global limit; account cap 429s with honest reasonCode; L12
  charge-count invariants hold (exactly one global + one account charge per genuine paid compute).
- **A3 (D10):** run `node scripts/build-tire-knowledge.mjs`; verify A/B/D agree; rewrite
  `corpusDrift.test.ts` per scout p6-corpus-scout section 5 option (a): floor = read meta.json at
  runtime * 0.99, drop the Turso skipIf + false doc-comment, keep the 10-golden-codes spot check,
  PLUS (review F7) one extra assertion: actual `Object.keys(barcodeIndex).length` read from
  tireKnowledge.generated.json equals meta.barcode_index_count - catches the regen-forgot-meta
  divergence class the current 3-way disagreement proved is real. If the build script fails on a
  fresh `harvest.lock` (<5 min), retry once before treating as a code failure (review F8);
  add `test:corpus-drift` to `qa:revision`; fix `docs/COMMANDS.md:62`; propagate the fresh count into
  README/master-plan register lines touched by C3.
**Track B - ops**
- **B1:** durable `checkRateLimit` via `LadderStorage.increment/get` keyed
  `ratelimit:<ip>:<windowStart>` (pattern = `chargeDailySlot`); migrate the GPT $-guard
  (`checkGptLadderBudget`/`recordGptLadderSpend`/`recordGptLadderCall`, aiSpendGuard.ts:236-348) onto
  the same KV seam (file path stays as dev fallback); GC-F legacy check. Tests: window rollover,
  concurrent increments (mock storage), $-guard persistence across "instances" (two storage handles).
- **B2:** `src/server/log.ts` structured logger (`logServerEvent({ route, event, reasonCode,
  businessId?, status })` -> single-line JSON console.error/warn) wired at every enumerated site in
  scout p6-ops #3 (ai-lookup kill-switch/rate/caps/provider-errors, resolve-scan, import-mapping,
  reconcile/match, share mint/serve failures). No payload bodies, no codes, no PII. Tests: spy
  console, assert shape + sanitization. KNOWN GAP (review F9): the circuit-breaker OPEN transition
  is client-only state with no server call site - it stays server-invisible after B2; closing it
  needs a new client telemetry POST, explicitly out of scope.
**Track C - surface**
- **C1:** Settings "Account" section: "Signed in as {email}" (getSession/onAuthChange) + Sign out
  button wiring the existing `signOut()` (auth.ts:90-93). Component test.
- **C2:** first-run banner on /scan per GC-D: shown when `scanFeed.length === 0` && business
  `firstScanAt` unset; plain copy ("Scan your first barcode to start counting - the input is already
  focused"); e2e asserts scanner input STILL focused with banner visible. Also B3-lite: idempotent
  `firstScanAt` set-once on the first counted scan (grep processScan; write AFTER count, fire-and
  -forget, never blocking the scan path). MOCK-BACKEND rule (review F5): the set-once flag lives in
  local Zustand-persisted state FIRST (so the banner dismisses for mock/demo users - the default
  backend everywhere); live-auth mode ADDITIONALLY mirrors it to the business doc, gated exactly
  like other Firestore-touching code. The banner condition reads the local flag, never Firestore.
- **C3:** README refresh (Scanbin + real ladder + fix its doc-map dead links); confirm D11 leftovers
  (CLAUDE.md trust language already reconciled - verify, don't rewrite).
**Track D - portability (heaviest; master-plan scoped)**
- **D1:** `src/app/api/account/export/route.ts` (auth pattern from share/route.ts:80-111): walk
  `COLLECTIONS` for the caller's businessId -> one JSON bundle (+ CSV per collection via csvExport
  builders where shapes fit); size-bounded streaming or chunked assembly; emulator test: only own
  business's docs, never another tenant's, never master collections.
- **D2:** `src/app/api/account/delete/route.ts` per GC-E (fresh ID-token re-verify + explicit
  confirm phrase) + Danger-zone UI (PIN gate pattern, export-first nudge) + emulator tests: tenant
  docs gone, OTHER tenant untouched, `catalogEntries` untouched, membership/profile rows removed.
  RECURSION (review F6): a plain doc.delete() does NOT cascade - use
  `getAdminDb().recursiveDelete(businessDocRef)` (verify the pinned firebase-admin supports it;
  else an explicit batched per-collection loop over COLLECTIONS). Orphaned subcollection data is
  NOT "deleted".
**Close:** full battery (test/tsc/ledger/golden/firebase/build/e2e) + `qa:bots` relevant suites +
Argus review-build + slim ultra review (2 finders) + agy Flash/medium light pass + ledger/PROGRESS/
memory checkpoint. Flag `/code-review ultra` moment to owner.

## Out of scope
Retail-corpus drift gate (fast-follow, owner-flagged); live-Turso count monitoring (D10 fork (b));
third-party APM/analytics SDKs (owner no-new-accounts rule); server-path master-candidate feed
(P5b GC10 carryover); any push/deploy/production promotion (owner-gated).

## Files
(NEW = file does not exist yet, created by its task.)
A: `src/lib/auth.ts`(+test), `src/app/api/ai-lookup/route.ts`, `src/server/decode/pipeline.ts`
(cap gate only), `src/services/security/aiSpendGuard.ts`(+tests), corpus generated/meta/status files,
`src/server/tire-knowledge/corpusDrift.test.ts`, `package.json`, `docs/COMMANDS.md`.
B: `src/services/security/aiSpendGuard.ts` (B1 owns it - serialize A2's charge-site edits vs B1's
storage edits: SAME FILE, run A2 before B1), NEW `src/server/log.ts`(+test), the 6 API route files.
C: `src/app/(app)/settings/page.tsx`, `src/app/(app)/scan/page.tsx` or LiveScanFeed-adjacent
component, `src/stores/scanStore.ts` (firstScanAt set-once), `README.md`.
D: NEW `src/app/api/account/export/route.ts`, NEW `src/app/api/account/delete/route.ts`,
`src/app/(app)/settings/page.tsx` (C1 owns the page - D2's UI lands AFTER C1; same file, serialize).

## Cost
All local/mocked/emulator - $0 external. Corpus regen is offline. No push/deploy/live calls.

## Known same-file serializations (say so when they bite)
`aiSpendGuard.ts`: A2 then B1. `route.ts` (ai-lookup): A2 then B2's logging lines. `settings/page.tsx`:
C1 then D2-UI. `scanStore.ts` (review F4): P5b's cloudCatalogResolve work MUST be committed before
C2 starts (C2 rebases on it); C2's firstScanAt edit is the only P6 touch on the monolith.
`pipeline.ts`: A2's capContext threading is the only P6 touch. Everything else parallel.
