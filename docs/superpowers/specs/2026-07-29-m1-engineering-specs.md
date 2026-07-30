# M1 Engineering Wave - Implementation-Ready Mini-Specs

Prepared by Agent E6, read-only scout, 2026-07-29. Scouted against the current `audit-fixes`
working tree (verified via `git status --short` / `git log` at scout time - see coordination
note under Spec 2). Each spec is self-contained: current state with file:line, exact change,
test plan, effort. Written so the M1 engineering wave can execute cold with no further research.

---

## Spec 1 - catalogEntries public-read leak: move disputedBy/auditLog out of the public doc

**Effort: M** (rules change + write-path split + reader updates + emulator test)

### Current state

- `firestore.rules:476-479` - the `catalogEntries` collection is fully public-read:
  ```
  match /catalogEntries/{id} {
    allow read: if true;
    allow write: if false;
  }
  ```
  This is intentional for the sanitized catalog fields (barcode/brand/model/size - see the
  comment at `firestore.rules:473-475`), but Firestore security rules cannot do field-level
  read filtering on a `get`/`list` - the whole document is exposed once read is allowed on the
  path. `retailCatalogEntries` (`firestore.rules:483-486`) has the identical shape and leak.
- `src/server/catalog/catalogDispute.ts:110-123` writes two fields onto that SAME public doc via
  `tx.update(ref, update)`:
  - `disputedBy` (line 110): `[...disputedBy, { businessId, at: now }]` - an array that
    accumulates raw `businessId` strings (tenant identifiers) capped at 50 (`DISPUTED_BY_CAP`,
    line 29).
  - `auditLog` (line 118-124): `{ at, action: "disputed", by: businessId, reason? }` - `by` is
    again the raw `businessId`, and `reason` is free-text the disputing shop typed
    (`sanitizeReason`, `catalogDispute.ts:48-55`, capped at 500 chars but NOT redacted of PII -
    it is just length-capped and trimmed).
  - `src/services/db/types.ts` and `src/app/api/catalog-review/[id]/route.ts:151-168` also write
    `auditLog` entries with `by` (a uid/caller identity string) on `verified`/`rejected` actions.
  - `src/services/catalog/sanitizeCatalog.ts:68` writes an initial `auditLog` entry
    (`by: meta.by`) at creation time.
- Because writes are exclusively via the Admin SDK (server routes only - confirmed no client
  Firestore SDK write path exists to `catalogEntries`), the rules' `allow write: if false` is
  already correct and does not need to change. The bug is 100% on the READ side: any client
  holding the public Firebase web config (which is inherently client-embeddable) can open the
  Firestore Web SDK and directly `getDoc`/`onSnapshot` a `catalogEntries/{id}` document, bypassing
  the app's API routes and `sanitizeCatalog.ts` entirely, and read every business that ever
  disputed that code plus their free-text reasons and the full moderation `auditLog`.
- Readers of these fields today (must keep working after the move):
  - `src/server/catalog/catalogDispute.ts:80,83-84,97,100-101,110,124,133,135` (read/write, in
    the Admin-SDK transaction - unaffected by rules, needs a path/collection change only).
  - `src/app/api/catalog-review/[id]/route.ts:151-168` (writes `auditLog` on
    verify/reject - Admin SDK, same treatment).
  - `src/services/catalog/sanitizeCatalog.ts:68` (writes an initial `auditLog` entry at
    creation - Admin SDK, same treatment).
  - No client-side (browser) code reads `disputedBy` or `auditLog` today (confirmed by
    grep - the 19 files matching `disputedBy|auditLog` are all server, test, or type files).
    `disputeCount` and `verificationStatus` (the AGGREGATE fields, not the raw arrays) ARE meant
    to stay public - they drive `classifyEntry`'s trust tier and are harmless (a count and an
    enum, no PII). Do not move those two.

### Exact change

1. **Move `disputedBy` and `auditLog` into a private subcollection**, e.g.
   `catalogEntries/{id}/moderation/{docId}` (one doc per event, or a single fixed-id doc
   `moderation/log` holding both arrays - prefer the single-doc form to minimize transaction
   read/write count changes in `catalogDispute.ts`'s existing transaction shape). Keep
   `disputeCount` and `verificationStatus` as top-level fields on the still-public
   `catalogEntries/{id}` doc (no change to those two).
2. **`firestore.rules`**: add a rule for the new subcollection directly under the `catalogEntries`
   match block (replace lines 476-479):
   ```
   match /catalogEntries/{id} {
     allow read: if true;
     allow write: if false;

     // Moderation trail (disputedBy/auditLog): contains raw businessId + free-text reasons.
     // NEVER public. Server (Admin SDK) writes only; no client read path exists or should exist.
     match /moderation/{docId} {
       allow read, write: if false;
     }
   }
   ```
   Mirror the identical `moderation` subcollection block under `retailCatalogEntries`
   (`firestore.rules:483-486`) even though no dispute path targets it today - same public-read
   shape, same latent risk if one is ever added; cheap to close now.
3. **`src/server/catalog/catalogDispute.ts`**: change the transaction to read/write
   `ref.collection("moderation").doc("log")` for `disputedBy`/`auditLog` instead of the parent
   `ref`. The parent `ref` transaction still handles `disputeCount`, `verificationStatus`,
   `updatedAt` (unchanged, lines 137-146). Two documents now change per dispute instead of one;
   keep them in the SAME `db.runTransaction` call (already open at line 78) so the split remains
   atomic - read both docs at the top of the transaction, branch, then `tx.update`/`tx.set` both.
4. **`src/app/api/catalog-review/[id]/route.ts:151-168`** and
   **`src/services/catalog/sanitizeCatalog.ts:68`**: same redirect - write `auditLog` entries to
   the `moderation/log` subcollection doc instead of the top-level `catalogEntries/{id}` doc.
   `sanitizeCatalogEntry`'s return type (`CatalogEntry` in `catalogTypes.ts`) should drop
   `auditLog` from the object it returns for the public doc write, and the caller
   (`masterAppend.ts` - verify at execution time) writes the initial `auditLog` entry to the
   subcollection in the same create transaction instead.
5. Grep for any OTHER reader that pulls a full `catalogEntries` doc client-side (e.g.
   `services/db/firebase/repositories.ts` catalog getters) and confirm none of them expose
   `disputedBy`/`auditLog` in a serialized response back to the browser - they should already be
   clean since sanitization happens on write, but verify no repository method does a raw
   passthrough of the Firestore doc data to a client-facing API response.

### Test plan

- New `src/services/db/firebase/catalogModeration.rules.test.ts` (follow the existing
  `*.rules.test.ts` pattern, e.g. `audit.rules.test.ts`): assert an unauthenticated AND an
  authenticated-but-unrelated client CANNOT read `catalogEntries/{id}/moderation/{docId}`
  (`assertFails`), while the parent `catalogEntries/{id}` doc read still succeeds
  (`assertSucceeds`) and returns no `disputedBy`/`auditLog` keys once the write path stops
  writing them there.
- Update `src/server/catalog/catalogDispute.test.ts`: existing assertions on `disputedBy`/
  `auditLog` shape move to asserting the subcollection doc; add a case proving the top-level doc
  (`disputeCount`, `verificationStatus`) is unaffected by the split.
- Update `src/app/api/catalog-dispute/route.test.ts` and
  `src/app/api/catalog-review/[id]/route.test.ts` for the new write target.
- Run `npm run test:firebase` (Firestore emulator rules + repository suite - required gate per
  CLAUDE.md for any Firestore sync/rules change).
- Manual/local proof: emulator UI, confirm `catalogEntries/{id}` no longer carries the two fields
  and `moderation/log` is unreadable via the client SDK with a signed-out or unrelated-business
  test user.

---

## Spec 2 - Kill-switch visibility: killSwitchOn in GET /api/ai-lookup + Settings banner

**Effort: S**

### Coordination flag

At scout time (`git status --short` / `git log -15`, verified before writing this spec),
`src/app/api/ai-lookup/route.ts` and `src/services/security/aiSpendGuard.ts` show **no
uncommitted working-tree changes** - both are clean relative to HEAD on `audit-fixes`
(53cd148c). The branch itself is many commits ahead of `master` with recent lane/audit work
(`feat(lane3)`, `docs(m0)` commits), so "uncommitted audit-fixes changes" most likely refers to
the branch's own history rather than a dirty working tree right now. **Before executing this
spec, re-run `git status`/`git diff` on these two files** - if either has moved since this scout
(new commits or new uncommitted edits), re-verify the exact line numbers below before patching;
the shape of the fix does not change, only the line anchors might.

### Current state

- `src/services/security/aiSpendGuard.ts:28-31` - `killSwitchOn(env)` already exists and is
  read server-side by the POST handler:
  ```ts
  export function killSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.AI_LOOKUP_KILL_SWITCH;
    return v === "1" || v === "true";
  }
  ```
- `src/app/api/ai-lookup/route.ts:232-236` (POST) already calls `killSwitchOn()` and returns 503
  when it's on - this part is NOT broken, the kill switch itself works.
- The **GET** handler (`route.ts:125-224`, the status endpoint Settings polls) does NOT call
  `killSwitchOn()` at all, despite `killSwitchOn` already being imported at line 9. The full
  response object is built at `route.ts:177-223` and has no `killSwitchOn` key. Result: a shop
  owner can have the server kill switch flipped on (all AI lookups 503ing) with Settings showing
  no indication why - `aiStatus.missingKeys` stays empty, `aiStatus.liveEnabled` stays true
  (it reflects `ENABLE_LIVE_AI_LOOKUP`, a DIFFERENT env var), so the UI looks healthy while every
  scan silently fails to decode.
- This is a genuinely different flag from `aiStatus.emergencyStop`
  (`src/stores/scanStore.ts:242`, toggled client-side via `setEmergencyStop` -
  `scanStore.ts:2821`, rendered as a toggle in Settings at
  `src/app/(app)/settings/page.tsx:289-294`, `data-testid="emergency-stop"`). `emergencyStop` is
  a CLIENT preference persisted in the local store; `AI_LOOKUP_KILL_SWITCH` is a SERVER env var
  the owner sets in Vercel. Do not conflate the two in naming or UI copy - they need separate
  rows so a shop owner can tell "I paused this myself" from "the server has this locked down".
- `AiStatus` type (referenced at `scanStore.ts:624` field, defined in `src/types.ts` - locate via
  the `AiStatus` type import) and `DEFAULT_AI_STATUS` (`scanStore.ts:230-246`) have no
  `killSwitchOn` field.
- `refreshAiStatus` (`scanStore.ts:2823-2858`) maps the GET response into `aiStatus` field by
  field (e.g. `liveEnabled: Boolean(d.liveEnabled)` at line 2834) - this is the exact pattern to
  extend.
- Settings page (`src/app/(app)/settings/page.tsx:280-300`) renders AI status rows including the
  `emergencyStop` toggle (289-294) and the `missingKeys` warning paragraph (295-300) - the new
  banner slots naturally between these two, following the existing `GeminiStatusRow.tsx`
  presentational-component pattern (small, prop-driven, `data-testid`-tagged, red/green text by
  boolean, no em/en dash per project convention).

### Exact change

1. `src/app/api/ai-lookup/route.ts` GET handler: add `const killSwitch = killSwitchOn();` near
   the other flag reads (~line 154-158 area) and add `killSwitchOn: killSwitch` to the JSON
   response object (~inside the `Response.json({...})` block, `route.ts:177-223`).
2. `src/types.ts` (wherever `AiStatus` is declared): add `killSwitchOn: boolean;`.
3. `src/stores/scanStore.ts:230-246` (`DEFAULT_AI_STATUS`): add `killSwitchOn: false,`.
4. `src/stores/scanStore.ts:2823-2858` (`refreshAiStatus`): add
   `killSwitchOn: Boolean(d.killSwitchOn),` to the mapped `aiStatus` object, following the exact
   style of the adjacent `liveEnabled`/`geminiEnabled` lines.
5. New small component `src/components/KillSwitchBanner.tsx`, modeled on
   `src/components/GeminiStatusRow.tsx`: takes `{ killSwitchOn: boolean }`, renders nothing when
   false, renders a clear red banner when true (e.g. "AI lookup is disabled server-side (kill
   switch on). Scans still count; identity lookup is paused until an operator turns this off.").
   `data-testid="kill-switch-banner"`.
6. `src/app/(app)/settings/page.tsx`: render `<KillSwitchBanner killSwitchOn={aiStatus.killSwitchOn} />`
   near line 295 (before or after the `missingKeys` block - visually it should outrank
   missing-keys since it is a total-stop condition, not a partial-degradation one).
7. Optionally (nice-to-have, not required for the spec's minimum bar): also surface it briefly in
   the main scan screen if `evaluateAutoDecode` (`scanStore.ts:252-` onward) already produces a
   per-scan reason string when auto-decode is blocked - confirm at execution time whether
   `killSwitchOn` needs to be added as a new branch there too (it currently is NOT checked by
   `evaluateAutoDecode`, only by the server POST route, so a scan under a live kill switch would
   attempt the fetch and get a 503 rather than being pre-emptively blocked client-side; that is
   acceptable per the TOP-LEVEL LAW - the scan still counts and the row still appears - but the
   Needs Review reason string should ideally say "AI lookup disabled (kill switch)" instead of a
   generic fetch-failure reason. Flag this as a possible follow-on, not blocking for M1).

### Test plan

- Extend `src/app/api/ai-lookup/route.d4.test.ts` (or add a sibling test) asserting GET returns
  `killSwitchOn: true` when `AI_LOOKUP_KILL_SWITCH=1` and `false`/absent otherwise.
- Extend `src/services/security/aiSpendGuard.test.ts` if any new helper is added (likely none
  needed - `killSwitchOn()` is reused as-is).
- New/updated component test for `KillSwitchBanner` (render with true/false props, assert
  presence/absence via `data-testid`).
- Settings page test: assert the banner renders when `aiStatus.killSwitchOn` is true (mock the
  store).
- `npx vitest run src/app/api/ai-lookup -t "kill"` plus the touched component/page tests;
  `npm run test:e2e` is not required for this (no live-provider or scan-flow behavior changes).

---

## Spec 3 - Clear-local-cache: hard-confirm naming the exact pending count

**Effort: S**

### Current state

- `src/stores/scanStore.ts:6677-6716` (`clearLocalCache`) unconditionally wipes
  `pendingSyncQueue` to `[]` (line 6695, inside the `common` object spread into both the cloud and
  mock-backend branches at lines 6709-6715) along with `scanFeed`, `finalCounts`,
  `needsReviewQueue`, etc. There is no check inside `clearLocalCache` itself for whether
  `pendingSyncQueue` is non-empty before wiping - the function has no awareness of "this would
  discard unsynced work."
- `src/app/(app)/settings/page.tsx:73-86` (`handleClearCache`) is the sole caller-facing gate
  today:
  ```ts
  function handleClearCache() {
    const ok =
      typeof window === "undefined" ||
      window.confirm(
        "Clear LOCAL browser cache? This wipes this browser's scan session, pending sync, and local " +
          "cached data only. Your cloud data is NOT deleted.",
      );
    if (!ok) return;
    if (requiresOwnerPin("clearCache", hasPin)) {
      setPinPrompt(true);
      return;
    }
    doClear();
  }
  ```
  The confirm text is GENERIC and static - it always mentions "pending sync" in the abstract but
  NEVER names how many scans are actually still unsynced. A shop owner clicking through this
  dialog when `pendingSyncQueue.length === 0` (nothing to lose) sees the exact same scary wording
  as one clicking through it with, say, 47 unsynced scans about to vanish - no differentiation,
  no exact count, so the warning is either ignored (false-alarm fatigue on the common case) or
  under-weighted (the rare case where it actually matters looks identical).
- `pendingSyncQueue` is read from the store elsewhere as
  `useScanStore((s) => s.pendingSyncQueue)` (confirmed pattern via `pendingCount: () =>
  get().pendingSyncQueue.length` at `scanStore.ts:6664`) - a ready-made selector/count already
  exists (`pendingCount()`) that this fix should reuse rather than re-deriving `.length` inline.
- `doClear()` (`settings/page.tsx:60-71`) itself has no gate either - it's the actual clear
  action, called either directly from `handleClearCache` (no-PIN path) or from `submitPin`
  (PIN path) - both currently skip any pending-count-specific check.

### Exact change

1. In `src/app/(app)/settings/page.tsx`, pull the pending count via the existing store action:
   `const pendingCount = useScanStore((s) => s.pendingCount());` (or
   `useScanStore((s) => s.pendingSyncQueue.length)` directly - either is fine, prefer the named
   selector for consistency with `scanStore.ts:6664`).
2. In `handleClearCache` (lines 73-86), branch the confirm copy on `pendingCount`:
   - `pendingCount === 0`: keep the existing generic wording (nothing at risk).
   - `pendingCount > 0`: force a SEPARATE, harder-worded confirm that explicitly NAMES the count,
     e.g.:
     ```ts
     const pendingCount = pendingSyncQueue.length;
     const message =
       pendingCount > 0
         ? `You have ${pendingCount} scan${pendingCount === 1 ? "" : "s"} not yet synced to the ` +
           `cloud. Clearing local cache will PERMANENTLY DISCARD ${pendingCount === 1 ? "it" : "them"} ` +
           `if they have not synced. Continue?`
         : "Clear LOCAL browser cache? This wipes this browser's scan session and local cached data. " +
           "Your cloud data is NOT deleted.";
     const ok = typeof window === "undefined" || window.confirm(message);
     ```
   - Keep the existing `requiresOwnerPin` gate unchanged and layered AFTER this confirm (same as
     today - PIN gate is a separate, orthogonal control from the pending-count warning).
3. No change needed inside `clearLocalCache` itself (`scanStore.ts:6677`) - the guard belongs at
   the UI trigger point (`handleClearCache`), matching where the existing `window.confirm` already
   lives; `clearLocalCache` stays a pure "do the wipe" action, consistent with how `doClear()` is
   structured today.
4. Double-check `src/stores/reconcileStore.ts`'s `clearLocalCache` (called at
   `settings/page.tsx:63`, "AM-R9" comment) doesn't ALSO hold pending work that should factor into
   the same count - confirm at execution time whether the reconcile session has its own
   unsynced-work concept; if so, either fold it into the same confirm count or add a second,
   clearly labeled line to the message (do not silently omit it if it exists).

### Test plan

- Existing `src/components/settingsClearCache.pin.test.tsx` and
  `src/stores/clearLocalCache.store.test.ts` already exercise this flow - extend them (do not
  replace) with: (a) `window.confirm` mock assertion that the message contains the literal count
  when `pendingSyncQueue.length > 0` (e.g. seed the store with 3 pending items, assert
  `confirm` was called with a string containing `"3"`), and (b) a case with
  `pendingSyncQueue.length === 0` asserting the generic message (no digit-count phrasing) is used.
- Regression case per CLAUDE.md's regression-protection rule: a test that fails before the fix
  (generic message shown regardless of count) and passes after.
- `npx vitest run src/stores/clearLocalCache.store.test.ts src/components/settingsClearCache.pin.test.tsx`.

---

## Spec 4 - /api/health route: reachability booleans, no secrets

**Effort: S/M** (new file, but small and pattern-following)

### Current state

- No `/api/health` (or similar) route exists today - confirmed via
  `Glob src/app/api/**/route.ts` (14 existing routes, none named `health`).
- Closest existing patterns to follow:
  - `src/app/api/ai-lookup/route.ts` GET handler (`route.ts:125-224`) already reports
    boolean-only provider-key presence (`geminiConfigured`, `openaiConfigured`,
    `firecrawlConfigured`, `goUpcConfigured` - never the key values themselves) plus a
    `daily`/`gptLadder`/`goUpc` usage snapshot. Reuse this exact boolean-only convention.
  - `src/app/api/telemetry/route.ts` shows the lightweight `json()` helper wrapper
    (`Cache-Control: no-store`) and `export const runtime = "nodejs"` pattern to copy.
  - Firestore reachability: `src/lib/firebaseAdmin.ts:41-45` exports `getAdminDb()` /
    `getAdminAuth()`. No existing lightweight "ping" helper exists yet - the health route will
    need to perform its own minimal read, e.g.
    `await getAdminDb().collection(COLLECTIONS.catalogEntries).limit(1).get()` (the public,
    already-cheap-to-read collection) wrapped in a timeout race and try/catch.
  - Turso reachability: `src/server/upc/storage.ts:510-514` (`ladderStorage()`) is the existing
    selector (Turso when `TURSO_DATABASE_URL`+`TURSO_AUTH_TOKEN` are both set, else the local
    file adapter). A meaningful health check should confirm the SELECTED backend actually
    responds, not just that the env vars are present - e.g. call `ladderStorage()` then a trivial
    read on the returned storage object (check `LadderStorage`'s interface in `storage.ts` for
    the cheapest available read method, likely a `get()` on a fixed/synthetic key that returns
    null harmlessly).
- Provider keys to report presence-only for (mirror `route.ts:154-171`): `GEMINI_API_KEY`,
  `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `GO_UPC_API_KEY`. Also worth adding (not currently in
  the ai-lookup GET): Firebase Admin credential presence (`GOOGLE_APPLICATION_CREDENTIALS` or
  equivalent - check `firebaseAdmin.ts:1-40` comment block for the exact env var name(s) it
  expects) as a boolean, since an uptime monitor watching this route wants to know "is auth
  configured at all" without the route needing to actually call `getAdminAuth()` for that part.

### Exact change

1. New file `src/app/api/health/route.ts`:
   - `import "server-only";`, `export const runtime = "nodejs";`,
     `export const dynamic = "force-dynamic";` (health checks must never be cached/stale).
   - `export async function GET()`: build a response with:
     - `ok: boolean` (overall - true only if the checks considered CRITICAL all pass; decide at
       execution time which checks are critical-for-`ok` vs advisory-only, e.g. Firestore
       reachability is probably critical, an individual provider key being unconfigured probably
       is not since the app functions in mock/degraded mode).
     - `firestore: { reachable: boolean, latencyMs?: number }` - wrap the `.limit(1).get()` call
       in `Promise.race` against a short timeout (e.g. 3000ms) so a hung Firestore connection
       cannot hang the health endpoint itself; catch and report `reachable: false` on any error,
       WITHOUT leaking the error message (log server-side via `logServerEvent`, return only the
       boolean to the caller - external uptime monitors are untrusted callers per the semantic
       firewall / secret-safety rules).
     - `turso: { reachable: boolean, backend: "turso" | "file", latencyMs?: number }`.
     - `providers: { gemini: boolean, openai: boolean, firecrawl: boolean, goUpc: boolean }`
       (presence-only, exact same booleans as `ai-lookup` GET already computes - consider
       factoring a tiny shared helper if it doesn't already exist, to avoid the two routes
       drifting).
     - `firebaseAdminConfigured: boolean`.
     - Explicitly DO NOT include: any key value, any connection string, any internal error
       message/stack trace, any business/tenant data. Add a one-line test asserting the response
       body serialized as JSON contains none of the raw env var VALUES (only booleans/numbers).
   - Rate-limit this route too (reuse `checkRateLimit`/`intEnv` from `aiSpendGuard.ts`, same
     `GET:${ip}` bucket pattern as `ai-lookup`'s GET, `route.ts:130-153`) - an external uptime
     monitor polling this every 30-60s is fine, but it is still a public unauthenticated endpoint
     and should not be a free unbounded probe surface, matching the project's existing posture on
     every other GET status endpoint.
2. No changes needed to any other file - this is additive only.

### Test plan

- New `src/app/api/health/route.test.ts`: assert 200 with `ok: true` when Firestore/Turso are
  reachable (mock the Admin SDK / ladderStorage calls, matching how
  `route.d4.test.ts` mocks `ai-lookup`'s dependencies); assert `reachable: false` fields (not a
  crash) when a dependency mock throws/times out; assert the JSON body contains no key-shaped
  strings (grep the serialized response for env var name substrings as a lightweight secret-leak
  regression test, similar in spirit to `src/services/keySafety.test.ts`).
- Assert rate limiting behaves like the `ai-lookup` GET's existing test coverage.
- Manual proof: `curl http://localhost:3000/api/health` against local dev, screenshot/paste the
  JSON body into the PR/handoff notes.

---

## Spec 5 - Alerting: Vercel log-drain -> webhook on kill_switch/cap_blocked/breaker_open/5xx

**Effort: S** (config-only; no new accounts, no new code beyond ensuring log lines are structured)

### Current state

- `src/server/log.ts` (`logServerEvent`, used throughout `route.ts`,
  `catalog-dispute/route.ts`, `telemetry/route.ts`, etc.) already emits structured server-side
  log lines with `route`, `event`, `reasonCode`, `status` fields - CONFIRM at execution time the
  exact `console.*` method it uses (likely `console.log`/`console.error` with a JSON-stringified
  payload) since Vercel's log drain forwards raw stdout/stderr lines; the alerting rule will
  pattern-match on the `event` field values already in use: `"kill_switch"` (`route.ts:234`),
  `"rate_limited"`, `"rate_limit_unavailable"`, plus need to confirm exact event names already
  emitted for `cap_blocked` and `breaker_open` (grep `logServerEvent.*event:` across
  `src/server/decode/pipeline.ts` and `src/app/api/telemetry/route.ts:12` -
  `ALLOWED_EVENTS = new Set(["breaker_open", "client_error"])` confirms `breaker_open` already
  has a defined client-reported event name flowing through `/api/telemetry`).
- No log drain, no webhook, no alerting destination is configured today (this is a config task,
  not a code task, per the task's own framing - "no accounts created").

### Exact change (config, not code - document for the owner to execute)

1. Confirm/standardize the exact `event` string values worth alerting on by grepping
   `logServerEvent(` call sites across `src/app/api/**` and `src/server/**` at execution time;
   the known set so far: `kill_switch`, `rate_limited` (maybe too noisy for alerting - advisory
   only), `cap_blocked` (verify exact name used by the daily-cap gate in
   `src/server/decode/pipeline.ts` or `aiSpendGuard.ts` - `chargeDailySlot`/`checkAndIncrementDaily`
   callers), `breaker_open` (from `client_error`/breaker telemetry), and any 5xx response
   (`status: 5xx` in the logged payload, or Vercel's own function-error log lines which don't go
   through `logServerEvent` at all - those need a separate Vercel-native alert rule, not a
   log-pattern one).
2. **Vercel Log Drain**: in the Vercel dashboard (Project Settings -> Log Drains), configure a
   drain pointed at a webhook URL (e.g. a Slack incoming-webhook URL, or a lightweight relay like
   a Zapier/Make webhook, or a self-hosted endpoint if one exists) filtered to this project's
   production logs. This is an owner-executed dashboard action, not code - flag it as such in the
   handoff, matching the project's `docs/DEPLOY_TRUTH.md` posture on dashboard-only steps.
3. **Minimal filter config**: Vercel Log Drains support filtering by log level/source but not
   arbitrary substring match at the drain level in all plans - if substring filtering on `event`
   values isn't available at the drain layer, the cheaper path is: drain ALL logs to a lightweight
   relay (e.g. a tiny serverless function or existing webhook tool) that itself pattern-matches
   the `event` field before forwarding to Slack/email/PagerDuty-equivalent, so Vercel-side cost
   stays flat and the filtering logic lives in one reviewable place. Document this as the
   recommended shape rather than a fixed vendor choice - the owner has not picked a destination
   yet per the task's "no accounts created" constraint.
4. **5xx alerting specifically**: Vercel already has native "Monitoring" -> alert rules for
   function error rate / 5xx count in most plans, which may be simpler than log-pattern matching
   for this one signal - flag this as the recommended path for 5xx specifically, separate from
   the `event`-field-based alerts for the other three signals.

### Test plan

- This is infra/config, not app code - no automated test applies. Proof is manual: trigger each
  condition in a controlled local/staging way (e.g. set `AI_LOOKUP_KILL_SWITCH=1` briefly in a
  preview deploy, confirm the log line appears in the Vercel dashboard with the expected `event`
  field) and confirm the drain/webhook fires. This step requires owner action (dashboard access,
  webhook destination choice) and should be called out as MANUAL PROOF, not automatable by an
  agent - do not claim it "works" without the owner confirming the webhook actually received a
  message.

---

## Spec 6 - Every-scan-feedback panel: render for EVERY outcome, not just "known"

**Effort: M** (UI logic + copy + tests across every ScanStatus value; the #1 activation fix per
the task framing, so treat this with proportionally more test care than its line-count suggests)

### Current state

- `src/components/ScannerInput.tsx:153` - `const counted = lastResult?.status === "known";` is
  the single gate deciding which of THREE render branches shows (`ScannerInput.tsx:185-227`):
  1. `counted` (only `status === "known"`) -> the big green "Added." success panel
     (lines 185-202), WITH the running quantity number.
  2. `lastResult == null` -> "Ready to scan." placeholder (lines 203-206).
  3. `isDecoding` -> blue "Looking up this product..." panel (lines 207-215).
  4. else (the fallback catch-all, lines 216-227) - EVERY other terminal status
     (`unknown`, `needs_review`, `resolved`, `ignored`, `conflict` - the full `ScanStatus` union
     minus `known`, defined at `src/types.ts:26`:
     `export type ScanStatus = "known" | "unknown" | "needs_review" | "resolved" | "ignored" | "conflict";`)
     all render through the SAME generic amber box, differentiated only by the
     `statusMessage()` text (lines 131-151) and a barely-different amber shade for `conflict`
     specifically (line 219: `conflict` gets `border-amber-500`, everything else gets
     `border-amber-400` - a one-shade difference most users will never perceive).
  - Per CLAUDE.md's TOP-LEVEL LAW, every scan already DOES appear in the feed and DOES count
    (this is enforced upstream by `ensureProvisionalCount` ordering, not by this component) - the
    bug here is purely about FEEDBACK QUALITY: an `unknown` scan sent to Needs Review currently
    gets visually near-identical treatment to a `conflict`, and neither gets the confidence-
    building big panel treatment a `known` scan gets, even though (per the LAW) the unknown scan
    also just successfully counted as an "Unidentified item" row. A new user watching the amber
    box after every single unknown scan (which, for an unfamiliar/new-shop catalog, could be the
    MAJORITY of early scans) never sees the satisfying "yes, this worked" feedback the green
    panel gives - this is a plausible activation-killer: the app FEELS like it's failing even
    when it's behaving exactly as designed (scan -> count -> review).
  - `statusMessage()` (lines 131-151) already has role-aware, per-status text branches
    (`isPlatform` vs customer view, `known`/`conflict`/fallback) - the text-generation logic is
    mostly reusable; the missing piece is PANEL STYLING keyed by status, and a quantity/count
    display for the non-known cases too (currently only the `known` branch shows
    `quantityAfterScan` at all, lines 198-200 - but per the TOP-LEVEL LAW every scan increments
    a count, including unidentified-item counts, so an unknown scan's row ALSO has a
    `quantityAfterScan` worth surfacing).

### Exact change

1. Replace the single `counted` boolean gate with a per-status style/label map, e.g.:
   ```ts
   type PanelStyle = { border: string; bg: string; text: string; heading: string };
   const PANEL_STYLES: Record<ScanStatus, PanelStyle> = {
     known:         { border: "border-green-600", bg: "bg-green-50",  text: "text-green-900", heading: "Added." },
     unknown:       { border: "border-amber-400", bg: "bg-amber-50",  text: "text-amber-900", heading: "Counted - needs ID." },
     needs_review:  { border: "border-amber-400", bg: "bg-amber-50",  text: "text-amber-900", heading: "Counted - needs review." },
     conflict:      { border: "border-amber-500", bg: "bg-amber-50",  text: "text-amber-900", heading: "Counted - conflict." },
     resolved:      { border: "border-green-600", bg: "bg-green-50",  text: "text-green-900", heading: "Counted." },
     ignored:       { border: "border-zinc-400",  bg: "bg-zinc-50",   text: "text-zinc-700",  heading: "Counted - ignored." },
   };
   ```
   (Exact color choices are a design decision for the M1 wave, not fixed by this spec - the
   important structural point is EVERY status gets an entry, none fall through to a shared
   generic branch, and every entry still communicates "counted" since per the TOP-LEVEL LAW it
   always is.)
2. Restructure the render (lines 185-227) to: `isDecoding` still short-circuits first (in-flight
   state, unaffected by this change) -> `lastResult == null` still shows "Ready to scan." ->
   otherwise ALWAYS render the big panel using `PANEL_STYLES[lastResult.status]`, always showing
   `lastResult.quantityAfterScan` in the number slot (remove the current restriction that only
   the `known`/`counted` branch gets the quantity display) with the SAME visual weight (size,
   font, animation) the green panel gets today - only the color/label change per status. This is
   the core of the fix: parity of visual confidence across every outcome, not just `known`.
3. Update the `flash` (border flash on the input itself, lines 102-111) similarly if desired -
   currently it's binary `success`/`error` keyed off the same `status === "known"` check
   (line 103); consider whether flash should stay binary (quick glance) while the panel below
   becomes status-differentiated (read-if-you-look), or whether flash should also gain a third
   "neutral counted" state. Decide at execution time; not blocking for the panel fix itself.
4. `data-testid="scan-success"` (line 188) is currently `known`-only; decide whether to keep
   `scan-success` reserved for `known` and add a new stable testid per status (e.g.
   `scan-counted`) so existing E2E tests asserting `scan-success` for known-scan flows are not
   silently broken by widening its meaning - SAFER to add a NEW shared testid
   (`data-testid="scan-counted"`) on the always-rendered panel and keep `scan-success` as an
   additional testid ONLY on the `known` variant, so existing tests keep passing unmodified.

### Test plan

- This is exactly the kind of change CLAUDE.md's TOP-LEVEL LAW test suite already guards
  adjacent behavior for - grep existing `ScannerInput` tests (component test file likely
  `src/components/ScannerInput.test.tsx` or similar - confirm exact name at execution time) and
  add one case per `ScanStatus` value asserting: (a) the panel renders (not the generic fallback),
  (b) it shows the status-appropriate heading/color testid, (c) it shows `quantityAfterScan`
  regardless of status.
- Add/extend an E2E test (`npm run test:e2e`) proving an UNKNOWN scan (no matching alias) shows a
  big, non-generic counted panel with the quantity visible - not just the amber fallback text -
  since this is explicitly the customer-facing perception fix; per CLAUDE.md's Human Bot Proof
  Gate, this is a customer-facing scanner change and needs `npm run qa:bots:*` browser proof with
  a screenshot before calling it done, not unit tests alone.
- Regression guard: assert the existing `known`-scan green-panel test (`data-testid="scan-success"`)
  still passes unmodified (proves the `scan-success` testid narrowing in change #4 didn't break
  it).

---

## Summary

**Specs written:** 6 (catalogEntries public leak, kill-switch visibility, clear-cache pending
guard, /api/health route, alerting config, every-scan-feedback panel).

**Total effort estimate:** ~2 M + 1 S/M + 3 S = roughly 1.5-2 engineer-weeks for the full M1
engineering wave if run mostly serially; Specs 2-4 are independent of each other and of Spec 1/6
and can run in parallel; Spec 5 is owner/config-gated and can run any time independent of code
work; Spec 6 should get the most test scrutiny relative to its size given its "#1 activation fix"
framing and its Human Bot Proof Gate requirement.

**Sharpest risk:** Spec 1 (catalogEntries leak). It is the only spec touching a currently-shipped
security posture on a collection that is deliberately, permanently public-read by design (the
comment at `firestore.rules:473-475` is explicit this is intentional for the catalog fields
themselves) - the fix must be surgical enough to preserve that public-catalog-read guarantee
(tire/retail lookups for the no-login app) while closing the specific field-level leak, and it
touches THREE separate write call sites (`catalogDispute.ts`, `catalog-review/[id]/route.ts`,
`sanitizeCatalog.ts`) plus the rules file, all of which must move in lockstep or a half-migrated
state could either break the dispute-transaction's atomicity or leave one write path still
writing the sensitive fields to the public doc. Spec 2's secondary risk (branch-state drift on
route.ts/aiSpendGuard.ts) is procedural, not technical - mitigated by the explicit re-verify
instruction in that spec's Coordination Flag section.
