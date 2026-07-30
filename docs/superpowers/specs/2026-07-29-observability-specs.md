# Observability Specs: Alerting + PostHog Funnel (M1/M5) - 2026-07-29

Scout: H4 (read-only). Implementation-ready; the account-gated steps are owner-only.
Neither dependency below is installed today (`grep -i posthog\|sentry package.json` = no hits).

---

## 1. Alerting on kill_switch / cap_blocked / breaker_open / 5xx

### 1.0 Ground truth: what actually gets logged today

`src/server/log.ts` `logServerEvent()` prints ONE JSON line per event via `console.error`
(status >= 500) or `console.warn` (everything else) - `{src:"scanbin", route, event, ts,
reasonCode?, businessId?, status?, detail?}`. Nothing consumes these lines today; they only
exist in Vercel's function log stream. Verified call sites and their exact `event`/`reasonCode`
values (grep `logServerEvent` across `src/app/api/**`, 2026-07-29):

| event | reasonCode(s) | status | Where |
|---|---|---|---|
| `kill_switch` | `kill_switch` | 503 | `src/app/api/ai-lookup/route.ts:242` |
| `cap_blocked` | `daily_cap`, `account_daily_cap` | 429 | `ai-lookup/route.ts:405,423,459,488` |
| `charge_pair_incomplete` | `charge_error` | 200 | `ai-lookup/route.ts:445` (counter divergence, non-fatal but worth watching) |
| `breaker_open` | `client_circuit_breaker_open` | 202 | via `POST /api/telemetry` (`src/app/api/telemetry/route.ts:80`), fired client-side from `src/stores/scanStore.ts:4057` (`postTelemetry("breaker_open", "decode_failure_threshold_reached")`) - this IS the server-visible bridge for the client-only circuit breaker (closes the KNOWN GAP noted in `log.ts:13-16`) |
| `rate_limited` | `rate_limited` | 429 | ai-lookup, health, catalog-review*, account/export, reconcile/match |
| `auth_reject` / `auth_unavailable` | various | 401/403/503 | import-mapping, resolve-scan, share, catalog-review*, account/export |
| `read_failed` / `write_failed` / `export_failed` / `mint_failed` | various | 500/503/413/400 | resolve-scan, catalog-review, catalog-dispute, share, account/export |
| `firestore_unreachable` / `turso_unreachable` | `firestore_error` / `turso_error` | 200 | `src/app/api/health/route.ts:51,65` (dependency down but route itself returns 200 with `ok:false`) |

Every 5xx line already goes through `console.error`, so a log-level filter (`level:error`)
is a cheap secondary net that catches future events even if the named-event list drifts.

### 1.1 Option A: Vercel Log Drain -> webhook (Slack/email)

Vercel Log Drains stream every function log line (JSON, matching the shape above) to an HTTPS
endpoint in near-real-time. No SDK, no new dependency in the app - purely a Vercel dashboard +
one small receiver.

**Steps (dashboard = owner-gated; receiver code = implementable now):**

1. **Owner-gated:** Vercel dashboard -> Project -> Settings -> Log Drains -> Add Log Drain.
   - Sources: check "Functions" (covers all `/api/*` routes, includes both `console.error` and
     `console.warn` lines).
   - Delivery format: NDJSON (one JSON object per line) or JSON array, either works with the
     receiver below.
   - Endpoint: the receiver URL (see 1.1a). Vercel Log Drains are a paid-plan feature on some
     tiers - confirm current plan supports it before relying on it as the only channel; if not
     available, use Option B (Sentry) or Option C (self-poll) instead.
2. **Owner-gated:** create the Slack Incoming Webhook (Slack workspace -> App settings -> add
   "Incoming Webhooks" -> copy the `https://hooks.slack.com/services/...` URL) OR set up an
   email-sending path (Resend, already has an authenticated plugin in this environment - see
   `resend:resend` skill - or a plain `mailto:` via a transactional provider). Store the webhook
   URL as a Vercel env var, e.g. `ALERT_SLACK_WEBHOOK_URL` (server-only, never `NEXT_PUBLIC_*`).
3. **Implementable now (no owner gate):** a new route `src/app/api/internal/log-drain/route.ts`
   that:
   - Verifies the Vercel Log Drain signature (`x-vercel-verify` header on first handshake
     request, then ongoing delivery - see Vercel's log-drain docs for the exact verification
     token flow) so this endpoint cannot be spoofed/flooded by an outside caller.
   - Parses each NDJSON line, extracts the embedded `message` field (Vercel wraps function
     `console.*` output; the app's own JSON payload is inside `message` as a string - `JSON.parse`
     it defensively, skip non-JSON lines silently).
   - Filters: `event in ("kill_switch","cap_blocked","breaker_open") OR status >= 500` (using the
     parsed payload's own `event`/`status` fields from the table above - this is the "filtered
     on event:(kill_switch OR cap_blocked OR breaker_open OR status>=500)" rule from the task).
   - Debounces: keep an in-memory (or Turso `ladder_kv`, reusing the existing KV store pattern
     from `src/services/security/aiSpendGuard.ts`) last-alert-sent timestamp per `event`+`route`
     key, minimum 5 minutes between duplicate alerts, so a burst of 500 cap_blocked events in one
     minute sends ONE Slack message, not 500.
   - Posts a short Slack message via the stored webhook URL: `"[scanbin] {event} on {route}
     ({reasonCode}, status {status}) x{count in last 5m}"`. No request bodies, codes, or business
     data - `logServerEvent`'s own sanitization already guarantees the source payload never
     carries those, so the alert message is safe to forward as-is.
   - Returns 200 quickly (Log Drains expect fast ACKs; do the Slack POST with a short timeout and
     never let a slow webhook block the ACK - fire-and-forget with `waitUntil` if on Vercel Edge,
     or a background `void` call in Node runtime).
4. Add `ALERT_SLACK_WEBHOOK_URL` to `docs/COMMANDS.md`'s env-var name list (names only, no
   values, matching the existing pattern for other secrets).

**Cost:** Vercel Log Drains are included on Pro/Enterprise plans for a limited volume; check the
current plan tier before counting on it. Slack Incoming Webhooks are free.

### 1.2 Option B: Sentry SDK (client + server), free tier

Sentry's free Developer plan (5k errors/month, 1 project) covers this app's current volume
easily and adds automatic error capture beyond just these 4 events (uncaught exceptions,
promise rejections, React error boundaries) - broader safety net than the log-drain approach,
at the cost of a new dependency and an account.

**Steps:**

1. **Owner-gated:** create a free Sentry account + project (this environment has an authenticated
   `sentry` MCP/plugin already listed - `mcp__plugin_sentry_sentry__authenticate` - so account
   creation/login can go through that once the owner approves it). Get the DSN.
2. **Owner-gated (new dependency):** `npm install @sentry/nextjs` (Next.js 16 App Router is
   supported; confirm current `@sentry/nextjs` version against Next 16 compat before installing -
   use the `sentry:sentry-get-started` or `sentry:sentry-instrument` skill, which is already
   available in this environment, to drive the actual install/config once approved).
3. Run `npx @sentry/wizard` (owner-approved) or hand-write `sentry.client.config.ts`,
   `sentry.server.config.ts`, `sentry.edge.config.ts` at the repo root per Next.js App Router
   convention. Set DSN from `NEXT_PUBLIC_SENTRY_DSN` (client-safe, DSNs are meant to be public)
   and `SENTRY_AUTH_TOKEN` (server-only, source-map upload) as Vercel env vars.
4. **Server-side event bridge (implementable now once the SDK is in):** in
   `src/server/log.ts` `logServerEvent()`, after the existing `console.error`/`console.warn`
   call, add a Sentry capture gated to the same filter as Option A:
   ```ts
   if (input.event === "kill_switch" || input.event === "cap_blocked" ||
       input.event === "breaker_open" || (typeof input.status === "number" && input.status >= 500)) {
     Sentry.captureMessage(`${input.route} ${input.event}`, {
       level: (typeof input.status === "number" && input.status >= 500) ? "error" : "warning",
       tags: { route: input.route, event: input.event, reasonCode: input.reasonCode },
       extra: { businessId: input.businessId, status: input.status }, // no detail/body - same sanitization law
     });
   }
   ```
   This keeps `log.ts`'s HARD SANITIZATION LAW intact (comment at `log.ts:7-11`): only the same
   six allowed keys ever reach Sentry, nothing new is forwarded.
5. Configure Sentry Alert Rules (dashboard, owner-gated): "when an event matching
   `tags.event:kill_switch OR tags.event:cap_blocked OR tags.event:breaker_open OR level:error`
   occurs, notify [Slack integration / email]" - Sentry has native Slack integration, no separate
   webhook code needed on this path.
6. Client-side: `Sentry.init` in `sentry.client.config.ts` auto-captures uncaught exceptions;
   optionally wrap `src/stores/scanStore.ts`'s existing `postTelemetry("breaker_open", ...)`
   call (`scanStore.ts:4057`) with an additional `Sentry.captureMessage("breaker_open", ...)` for
   redundancy with the server-side bridge above (belt-and-suspenders, not required since the
   server bridge already covers it once `/api/telemetry` receives the POST).

**Cost:** Sentry free tier = $0, 5k events/month, 30-day retention. Both SDKs (client ~24KB
gzipped, server negligible) are a new dependency and need `npm install` approval per project law.

### 1.3 Uptime monitor target

`GET /api/health` (`src/app/api/health/route.ts`, verified 2026-07-29) is public, unauthenticated,
rate-limited (`HEALTH_RATE_LIMIT`, default 60/window), returns `{ok, firestore, turso, aiKeys,
version, timestamp}` with `Cache-Control: no-store`. `ok` reflects only Firestore + Turso
reachability (aiKeys is advisory, never flips `ok`). Point any external uptime monitor
(UptimeRobot free tier, Better Uptime free tier, or Vercel's own monitoring) at this URL,
checking `ok === true` and HTTP 200; alert when `ok:false` persists past N consecutive checks
(2-3 recommended to absorb a single transient timeout) or the endpoint itself times out/5xxs.
This is a separate owner-gated account setup (whichever monitor is chosen), no code change
needed - the route is already monitor-ready.

---

## 2. PostHog Activation Funnel Instrumentation

PostHog is not yet wired into the app code (no `posthog-js`/`posthog-node` import anywhere under
`src/`; only skill/doc references exist). This section specs the six funnel events, their exact
trigger points, sanitized properties, and setup steps.

### 2.0 Global rules for every event below

- **No PII, no prices.** Never pass email, name, phone, raw scanned codes, product names, cost,
  or margin as a property - same sanitization law as `log.ts`. Use only IDs, counts, booleans,
  and enums.
- **`businessId` is the identity to `posthog.identify()`/group on**, not any personal identifier
  (matches the multi-tenant `businessId`-scoping model already used everywhere else in this
  codebase). Use PostHog Group Analytics: `posthog.group("business", businessId)` so every event
  below auto-attaches to the business, including the virtual-shops synthetic runs (task note:
  "this measures the virtual-shops runs too" - those runs already carry a `businessId` like any
  other tenant, so no special-casing is needed as long as every event includes `businessId`/uses
  the group call; virtual-shop traffic will simply show up as its own group(s) in PostHog,
  distinguishable by whatever naming convention the virtual-shop harness already uses for its
  synthetic business IDs).
- **Client-side only** (`posthog-js`), since all six trigger points are client code paths (auth
  UI, scanStore, ReconcilePanel). No server-side `posthog-node` needed for this funnel.
- Guard every call: `if (typeof window !== "undefined" && posthogClient) posthogClient.capture(...)`
  - never let a missing/blocked PostHog script throw and break the scan flow (same fail-open
    philosophy as `postTelemetry` in `scanStore.ts`).

### 2.1 Event: `signup`

- **Trigger point:** `src/lib/auth.ts:266` `signUp(email, password)`, called from
  `src/app/login/page.tsx:67` (`mode === "signup" ? await signUp(...) : ...` inside
  `handleSubmit`, `login/page.tsx:50`). Fire immediately after `signUp()` resolves successfully
  (has a `cred.user`), before/alongside the existing post-signup provisioning flow.
- **Properties:** `{ method: "password" }` (or `"google"` for `signInWithGoogle`,
  `auth.ts:281`, if that path should also count as signup-equivalent for a first-time user -
  decide based on whether Google sign-in on a brand-new account should count; recommend firing
  `signup` only on `createUserWithEmailAndPassword` success and a parallel `signup` fire on first
  successful `signInWithGoogle` IF no existing membership was found, to avoid double-counting
  returning Google users as new signups). No email/name in properties - identify by uid via
  `posthog.identify(user.uid)` if per-user identity is wanted, or skip user-level identify
  entirely and group only on `businessId` once the workspace is provisioned (simpler, matches the
  no-PII rule most conservatively).

### 2.2 Event: `first_scan`

- **Trigger point:** `src/stores/scanStore.ts:2238` `processScan(rawInput)`, at the very top of
  the function body (after the existing `ensureAutoSession()` call around line 2249, before the
  cleaning/resolution logic) - this fires for EVERY scan attempt regardless of outcome, matching
  the TOP-LEVEL LAW that every scan counts/appears.
- **"First" semantics:** processScan does not currently track a per-business "have they ever
  scanned" flag. Two implementation options: (a) check a new boolean in the business's settings/
  Firestore doc (`hasScannedBefore` or similar) client-side before firing, set it true after
  first fire - adds a small piece of new state; (b) let PostHog itself determine "first" via its
  own event-history query (an Insight filtering `first_time_for_user` on the `scan_attempted`
  event) instead of gating client-side - simpler, no new app state, recommended. If (b) is
  chosen, fire a plain `scan_attempted` event on every scan (not literally named `first_scan`)
  and build the "first scan" funnel step in PostHog's UI as "first occurrence of `scan_attempted`
  per business group."
- **Properties:** `{ resolverStatus: resolution.resolverStatus /* known|unknown|conflict */,
  codeType: resolution.codeType /* upc|ean|gtin|sku|vendor_label|unknown - already an enum, no
  raw code */ }`. Never include `cleaned.cleanCode`, `rawInput`, or `matchedProductId`.

### 2.3 Event: `first_successful_count`

- **Trigger point:** same function, at `scanStore.ts:2331`
  `if (effectiveCountable && effectiveProductId) { ... }` - fire inside this branch, right after
  the optimistic `set((s) => ({ scanFeed: ... }))` update (around `scanStore.ts:2336-2337`,
  before/after the local state commit - after is safer so the event only fires once the count is
  actually applied). This is the true "aha moment": a scan that counted toward inventory, not
  just appeared in the feed.
- **"First" semantics:** same recommendation as 2.2 - name the raw event `count_applied` and let
  PostHog compute "first occurrence per business" as the funnel step, rather than adding new
  client-side first-time tracking state.
- **Properties:** `{ matchType: resolution.matchType /* sku|barcode|gtin|upc|ean|exact_alias|
  normalized_alias|unknown - enum, no code value */, quantityAfterScan: count.quantity }`
  (a count is not a price - safe to include).

### 2.4 Event: `weekly_return`

- **Trigger point:** no existing "last active" timestamp exists in this codebase today (verified:
  no `lastActiveAt`/`lastSeenAt` field in `scanStore.ts`, `autoSession.ts`, or business types).
  Needs one small new piece of state: on app bootstrap - `src/app/(app)/scan/page.tsx`'s mount
  effect (the file that already calls into `ensureAutoSession`) or a shared root layout effect -
  read a `lastActiveAt` value (Firestore business doc field, or simplest: a `localStorage` key
  scoped by `businessId`, e.g. `sis-last-active:{businessId}`), compare to `Date.now()`, and if
  the gap is >= 7 days (or the business has a prior `lastActiveAt` at all, to distinguish "return"
  from "first ever visit"), fire `weekly_return`. Then unconditionally update `lastActiveAt` to
  now on every app open (not just on the return case).
- **Properties:** `{ daysSinceLastActive: Math.floor(gapMs / 86400000) }`. No behavioral/content
  data.
- **Note:** this is the one event of the six that needs new application state (a last-active
  timestamp) rather than piggybacking an existing call site - flagged here rather than glossed
  over, per the no-partial-completion rule.

### 2.5 Event: `reconcile_run`

- **Trigger point:** `src/components/ReconcilePanel.tsx:107` `async function onRunCompare()`,
  wired to the button at `ReconcilePanel.tsx:190-191`
  (`data-testid="reconcile-run" onClick={() => void onRunCompare()}`). Fire at the start of
  `onRunCompare()` (attempt) and optionally a second `reconcile_run_completed` after the
  `fetch("/api/reconcile/match", ...)` call (`ReconcilePanel.tsx:114`) resolves successfully, to
  distinguish attempted-vs-completed reconciliation runs.
- **Properties:** `{ rowCount: <number of parsed CSV rows sent>, bucketCounts:
  { matched, unmatched, conflict } }` (counts only - never the CSV content, part numbers, or
  barcodes themselves, which is exactly what the file already contains and must not leave the
  device as an event property).

### 2.6 Event: `upgrade`

- **Trigger point:** does not exist yet. `Glob **/*pricing*` and `**/upgrade/**` under `src/`
  both return no application code (only doc/report files) - there is no pricing page, billing
  flow, or Stripe integration in this codebase today (Stripe MCP plugin is available but unused
  in `src/`). This event cannot be wired to a real trigger point until that flow is built.
- **Spec for when it lands:** fire `upgrade` at the point a paid-tier action is confirmed (e.g.
  a Stripe Checkout `success_url` redirect handler, or a webhook-driven route once Stripe is
  integrated), with properties `{ plan: <tier name>, fromPlan: <prior tier> }` - no dollar
  amounts as event properties (Stripe's own dashboard is the source of truth for revenue;
  PostHog should track the funnel step, not duplicate billing data). Track this as a follow-up
  spec item once a pricing/billing feature is actually planned - listing it here now so the
  funnel's final step is documented, not silently dropped.

### 2.7 Setup steps (free tier, owner-gated)

1. **Owner-gated:** create/confirm a free PostHog Cloud account and project (this environment has
   an authenticated `posthog` MCP plugin - `mcp__plugin_posthog_posthog__authenticate` - and a
   `posthog:llma-cc-setup` skill already available; use those once approved). Free tier covers
   1M events/month, more than enough for this app's current traffic.
2. **Owner-gated (new dependency):** `npm install posthog-js`.
3. Add `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` (client-safe, matches PostHog's
   own convention of a public project API key) as Vercel env vars; document names (no values) in
   `docs/COMMANDS.md`.
4. Initialize once in a client-only provider/effect (e.g. `src/app/providers.tsx` if one exists,
   or a small new `PostHogProvider` client component wrapping the root layout), with
   `person_profiles: "identified_only"` to avoid creating anonymous person profiles for every
   visit (keeps free-tier event/person budget efficient and avoids over-collecting on
   unauthenticated traffic).
5. Wire the five implementable events (2.1-2.3, 2.5) plus the new last-active state for 2.4 per
   the trigger points above. Leave 2.6 (`upgrade`) as documented-but-not-implemented until a
   billing flow exists.

---

## Owner-gated steps (consolidated)

1. Vercel dashboard: enable Log Drains (Option A) - plan-tier dependent, may not be available.
2. Slack Incoming Webhook creation (Option A) or Sentry account + Slack integration (Option B).
3. `npm install @sentry/nextjs` approval (Option B) - new dependency.
4. Sentry account/project creation + DSN + `SENTRY_AUTH_TOKEN` (Option B).
5. Uptime monitor account (UptimeRobot/Better Uptime/etc.) pointed at `/api/health`.
6. PostHog Cloud account + project + API key.
7. `npm install posthog-js` approval - new dependency.
8. Env vars added to Vercel (`ALERT_SLACK_WEBHOOK_URL`, `NEXT_PUBLIC_SENTRY_DSN`,
   `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`).

Everything else above (receiver route code, `log.ts` bridge, event call sites, funnel event
wiring, docs updates) is implementable without further owner input once the account/dependency
gates are cleared.
