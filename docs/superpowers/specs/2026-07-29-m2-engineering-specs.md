# Milestone 2 Engineering Specs — "Make it sellable"

- **Author:** Scout agent H2 (Sonnet)
- **Date:** 2026-07-29
- **Scope:** implementation-ready mini-specs for the three M2 engineering items in
  `docs/superpowers/plans/2026-07-29-product-readiness-master-plan.md` §4 Milestone 2. Read-only scout;
  nothing implemented. Cold-start ready for the build wave.
- **Dependency baseline (verified):** M1 is committed on this branch (`92e9c32c feat(m1): kill-switch
  visibility + clear-cache guard + /api/health + every-scan feedback`, plus `f416404e`, `a457a0e5`).
  `src/app/api/health/route.ts` and `src/components/KillSwitchBanner.tsx` exist. Live auth is ON in
  production (`NEXT_PUBLIC_AUTH_MODE` resolves to `"live"` per master plan §3, verified from the prod
  bundle). All three specs below can build directly on live auth without re-verifying that unknown.

---

## Spec 1 — Stripe Payment Link gating (manual entitlement, zero Checkout/webhooks)

**Master plan line:** M2 row "Billing v1 (customers 1-5): Stripe Payment Link + manual access gating by
businessId — zero code, ships this week." Owner-gated: Yes (Stripe account exists per owner, but this is
a manual/no-code billing path — no live Stripe API integration in this spec).

### Current state
- `Business` interface (`src/services/db/types.ts:8-15`) has no plan/entitlement/billing field at all:
  `id, name, slug?, createdBy, createdAt?, updatedAt?`.
- Business creation: `provisionBusiness` (`src/server/business/provisioning.ts`, invoked from
  `src/app/api/businesses/provision/route.ts:96`) creates the Firestore `businesses/{id}` doc via the
  Admin SDK on `ensure_default`/`create_named`. No entitlement is written at creation.
- No Stripe code exists anywhere in `src/` (`grep -rl stripe|Stripe src` returns zero hits). The `stripe`
  Claude plugin/skill is installed locally but the app has no integration.
- Access gating today is purely membership-based: `BusinessContextGate`
  (`src/components/BusinessContextGate.tsx:19-56`) resolves the signed-in user's `listMemberships()`
  (`src/lib/auth.ts:409-442`), finds the selected business, and if a membership exists calls
  `setBusinessContext(businessId, uid)` — full app access, unconditionally. `AuthGuard`
  (`src/components/AuthGuard.tsx:14-40`) only checks "is there a session", never "is this business paid".
  Neither gate reads any billing/plan field because none exists.

### Exact change
1. **Add an entitlement field to `Business`** (`src/services/db/types.ts:8-15`):
   ```ts
   export type PlanStatus = "trial" | "active" | "past_due" | "canceled";
   export interface Business {
     id: string;
     name: string;
     slug?: string;
     createdBy: string;
     createdAt?: unknown;
     updatedAt?: unknown;
     planStatus?: PlanStatus;   // absent/undefined == "trial" (back-compat: existing docs have no field)
     planUpdatedAt?: unknown;
     planUpdatedBy?: string;    // uid of the owner-operator who manually flipped it
   }
   ```
   Absent-field-means-trial is deliberate: every existing production `businesses/{id}` doc has no
   `planStatus`, so the default must be permissive (trial), never fail-closed on rollout — a strict
   `planStatus === "active"` check would instantly lock out every current user, including the owner's
   own test accounts.

2. **New server-only entitlement check**, `src/server/business/entitlement.ts` (new file, mirrors the
   read-only style of `src/server/business/provisioning.ts`):
   ```ts
   export type Entitlement = { allowed: boolean; status: PlanStatus; reason?: string };
   export async function checkEntitlement(db: AdminFirestore, businessId: string): Promise<Entitlement> {
     const snap = await db.collection("businesses").doc(businessId).get();
     if (!snap.exists) return { allowed: false, status: "canceled", reason: "business_not_found" };
     const status = (snap.data()?.planStatus as PlanStatus | undefined) ?? "trial";
     const allowed = status === "trial" || status === "active";
     return { allowed, status, reason: allowed ? undefined : "plan_inactive" };
   }
   ```
   `trial` allows access deliberately — this is the manual-gating MVP, not a hard paywall from day one;
   the owner flips a business to `past_due`/`canceled` by hand after a Payment Link customer stops paying
   (or flips new signups straight to a locked `past_due` state if pre-paid access is required — see
   Open Question below).

3. **New API route** `src/app/api/businesses/[businessId]/entitlement/route.ts` — `GET` returns
   `{ allowed, status }` for the businessId in an authenticated member's own membership (reuse the
   Bearer-token verify pattern from `src/app/api/businesses/provision/route.ts:69-93`; 403 if the caller
   has no membership row for that businessId — reuse `COLLECTIONS.businessMembers` lookup pattern from
   `src/lib/auth.ts:415`, server-side via Admin SDK).

4. **New admin-only route** `src/app/api/businesses/[businessId]/plan/route.ts` — `POST { planStatus }`,
   restricted to a hardcoded owner-operator allowlist (env var `PLATFORM_OWNER_UIDS`, comma-separated
   Firebase uids — NOT a business `owner` role, which is per-tenant; this is the SaaS operator, i.e. you).
   This is the manual toggle the master plan calls for. No UI needed for MVP — curl/Postman is
   acceptable per "manual gating" scope; a thin admin page is a nice-to-have, not required.

5. **Wire the gate into `BusinessContextGate`** (`src/components/BusinessContextGate.tsx`): after the
   membership is found (~line 34) and before `setBusinessContext` (~line 51), fetch
   `/api/businesses/{businessId}/entitlement`. If `allowed === false`, set a new status
   `"plan_inactive"` and render a blocking screen ("Your workspace's subscription needs attention —
   contact support" + a mailto/Payment Link URL) instead of the children. Mirror the existing
   `"no-business"`/`"adopt-choice"` state-machine style already in this component (~line 24: the
   `status` useState union) rather than inventing a new pattern.

6. **Manual operational flow** (documented, not code): owner sends the Stripe Payment Link URL to a
   customer; on payment, owner manually calls the admin route (or a future thin admin page) to set
   `planStatus: "active"`; if a customer churns, owner flips to `"canceled"`.

### Where real Stripe Checkout+webhooks slot in later (do NOT build now)
When manual stops scaling (master plan explicit non-goal for now): a `/api/stripe/webhook` route
verifying Stripe signatures, listening for `checkout.session.completed` / `customer.subscription.updated`
/ `.deleted`, writing `planStatus` + `stripeCustomerId` + `stripeSubscriptionId` onto the same `Business`
doc fields already defined in step 1 above — the schema in step 1 is intentionally shaped so v2 billing
is an additive write path (webhook writes the same fields the manual admin route writes today), not a
schema migration. `checkEntitlement` (step 2) does not change at all when v2 lands.

### Test plan
- Unit: `checkEntitlement` — trial (no field) allowed; `active` allowed; `past_due`/`canceled` blocked;
  nonexistent business blocked.
- Integration (`test:firebase`): entitlement route requires a valid membership for the businessId
  (403 for a member of a different business); admin plan-flip route requires `PLATFORM_OWNER_UIDS`
  membership (403 otherwise); a flipped `canceled` business blocks `BusinessContextGate` end to end
  (component test, mock `getSession`/`listMemberships`/`fetch`, mirror
  `BusinessContextGate.orphan.test.tsx` pattern already in the repo).
- Browser proof (`qa:bots:*` per CLAUDE.md's customer-facing gate): sign in as a member of a
  `planStatus: "canceled"` business, confirm the blocking screen renders instead of `/scan`, screenshot.

### Effort: **M** (schema field + 2 routes + 1 gate wire + tests; no live Stripe API call at all)

### Owner-gated?
- Design/spec: No.
- Flipping a real customer's `planStatus` after a real payment: **Yes** (real business record mutation).
- Anything touching the live Stripe dashboard/account itself: **Yes** (per CLAUDE.md forbidden-actions).

### Open question for the owner (flag, do not decide silently)
Should a brand-new signup default to `trial` (immediate full access, matches current code default) or
should new signups be locked (`past_due`) until the owner manually activates after a Payment Link
purchase? The master plan text ("customers 1-5 ... + manual access gating") reads as pre-paid gating,
but current architecture has no "pending signup" concept — recommend trial-by-default for the first
batch (low volume, owner personally onboards each customer) and revisit if self-serve volume grows.

---

## Spec 2 — Per-tenant decode cost metering (plan-tier caps)

**Master plan line:** M2 row "Per-tenant usage/cost metering + plan-tier caps on the paid decode ladder
(today capped only globally) — required before customer #2." Owner-gated: No.

### Current state — IMPORTANT: per-account metering is ALREADY BUILT AND WIRED, not greenfield
This is the single biggest finding of this scout: the master-plan line describing this as "today capped
only globally" is **stale**. Per-account daily-cap infrastructure already exists and is live in both
decode paths:
- `src/services/security/aiSpendGuard.ts:172-200` — `perAccountDailyKey`, `readDailyUsedForAccount`
  (pure read), `chargeDailySlotForAccount` (atomic increment) already exist, using the same durable
  `LadderStorage` KV seam (`get`/`set`/`increment`) as the global `chargeDailySlot`.
- `src/app/api/ai-lookup/route.ts:393-467` (legacy `lookup` mode) — for `authedBusinessId` traffic, the
  **per-account cap is checked FIRST** (line 400-414, blocks with `reasonCode: "account_daily_cap"`
  before falling through to a platform-wide `AI_LOOKUP_GLOBAL_BACKSTOP` backstop, sized
  `AI_LOOKUP_DAILY_LIMIT * 10` by default — line 418). Both the global and account slots are charged
  together (line 441-454) with an explicit charge-pair-consistency comment (a divergence is logged, not
  fatal).
- `src/app/api/ai-lookup/route.ts:469-499` and `src/server/decode/pipeline.ts:1528-1550` (decode-mode
  path) — same per-account gate before the pipeline runs (`acctUsed`/`acctLimit` check, route.ts:483-497),
  threading `accountCapCleared` into the pipeline so the pipeline's own internal global gate compares
  against the backstop instead of double-gating an already-cleared tenant.
- The account cap value comes from **one single env var for every tenant**:
  `AI_LOOKUP_ACCOUNT_DAILY_LIMIT` (falls back to `AI_LOOKUP_DAILY_LIMIT`, default 2000) — see
  route.ts:401 and route.ts:484. There is no per-business override and no plan-tier concept.

### What is genuinely missing (the real gap, scoped correctly)
1. **Plan-tier differentiation.** Every business gets the identical `AI_LOOKUP_ACCOUNT_DAILY_LIMIT`
   regardless of what they pay. There is no field on `Business` (or elsewhere) carrying a per-tenant cap
   override.
2. **Owner/operator visibility.** `getGptLadderStatus` (`aiSpendGuard.ts:463-469`) exists and returns
   `{ spentUsd, capUsd, calls, allowed }` for the GLOBAL GPT-ladder dollar guard, but there is no
   per-account equivalent status function, and nothing in `src/app/(app)/settings/page.tsx` surfaces
   AI-lookup usage to the signed-in business at all (`grep -n "getGptLadderStatus|spentUsd|acctUsed"
   "src/app/(app)/settings/page.tsx"` returns zero hits). A shop owner has no way to see "you've used
   340/2000 of today's AI lookups" — cost-per-customer stays invisible exactly as the master plan flags.
3. **Dollar-level per-account guard.** The GPT ladder's dollar cap (`checkGptLadderBudget`/
   `recordGptLadderSpend`, `aiSpendGuard.ts:277-379`) is call-count-agnostic and entirely global — no
   per-account dollar ceiling exists at all (only the call-count cap is per-account).

### Exact change
1. **Add a per-business cap override field.** Extend the `Business` interface (same file/edit as Spec 1
   step 1, `src/services/db/types.ts`) with:
   ```ts
   aiLookupDailyLimit?: number; // overrides AI_LOOKUP_ACCOUNT_DAILY_LIMIT for this business; undefined = env default
   ```
2. **Resolve the effective per-tenant limit** in both call sites (`route.ts:401` and `route.ts:484`):
   replace `intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, limit)` with a small helper
   `resolveAccountLimit(business, envDefault)` that reads `business.aiLookupDailyLimit` when present and
   falls back to the existing env-var chain otherwise. This requires fetching the `Business` doc (or its
   `aiLookupDailyLimit` field) in the route — today the route only has `authedBusinessId` (a string), not
   the doc. Cheapest approach: fetch via Admin SDK once per request (`getAdminDb().collection("businesses")
   .doc(authedBusinessId).get()`), same call shape already used elsewhere in the API routes; cache is not
   required at MVP volume (low daily request count per the "customers 1-5" framing).
3. **Add `getAccountLadderStatus(businessId)`** to `aiSpendGuard.ts` (mirrors `getGptLadderStatus`,
   composes `readDailyUsedForAccount` + the resolved limit) so a status endpoint and Settings UI can show
   real numbers without duplicating cap logic.
4. **New route** `src/app/api/businesses/[businessId]/ai-usage/route.ts` — `GET`, authenticated + membership
   check (same pattern as Spec 1's entitlement route), returns `{ used, limit, spentUsdToday? }` for the
   caller's own business only.
5. **Settings UI**: add a small "AI lookup usage today: X / Y" readout to
   `src/app/(app)/settings/page.tsx`, fetched from the new route on mount — this is the visibility gap
   closer, the highest-value part of this spec since the metering enforcement already exists.
6. **(Optional, defer if time-boxed)** a per-account dollar guard mirroring the GPT ladder's cents-based
   pattern (`checkGptLadderBudget`), keyed by `businessId` instead of just date. Lower priority than 1-5:
   the call-count cap already bounds worst-case spend per tenant since each call has a bounded max cost;
   a dollar-precise per-tenant guard is a refinement, not a gap that risks "silent AI-cost loss" the way
   the plan-tier/visibility gaps do.

### Test plan
- Unit (`aiSpendGuard.test.ts`, extend existing file): `resolveAccountLimit`/`getAccountLadderStatus`
  honor a business override over the env default; falls back correctly when the field is absent.
- Route test (extend `src/app/api/ai-lookup/route.test.ts`): a business with `aiLookupDailyLimit: 5`
  blocks on the 6th call even though the global env default is 2000; a business with no override still
  uses the env default (regression — must not change today's behavior for existing tenants).
- New `ai-usage` route test: returns correct `{used, limit}` for the caller's own business; 403 for a
  businessId the caller isn't a member of.
- Settings component test: renders "X / Y" from a mocked fetch; hides gracefully on fetch failure (never
  block the rest of Settings from rendering).

### Effort: **M** (mostly wiring — the hard atomic-storage primitives already exist and are proven in
production paths; the new work is a business-doc field, a resolver function, a status endpoint, and a
Settings readout)

### Owner-gated?
No — no billing, no prod credentials, no real customer data touched. Pure app-logic + a new optional
Firestore field with a safe default (undefined = today's env-driven behavior, zero regression risk).

---

## Spec 3 — Self-serve signup polish: `workspace_failed` recovery UX + member-management UI

**Master plan line:** M2 row "Self-serve signup polish + rewrite `workspace_failed` recovery UX +
member-management UI." Owner-gated: "Depends on auth flip" (master plan's own note) — auth flip is
DONE (live in prod, verified), so this item is **unblocked**, not gated, contrary to the master plan's
conditional phrasing which was written before the verification landed.

### Current state — both pieces are PARTIALLY built already, not greenfield
This is the second correction to the master plan's framing: both the recovery UX and the member UI
already exist in a first-pass form; the work is polish/completion, not creation from zero.

**`workspace_failed` recovery (`src/app/login/page.tsx`):**
- Line 34-41: on `result.status === "workspace_failed"`, the page already sets `workspaceRetry = true`
  and shows a notice ("Your account was created, but its workspace still needs setup." /
  "You are signed in, but your workspace still needs setup.").
- Line 127-137: a "Retry workspace setup" button already exists, wired to `handleWorkspaceRetry`
  (line 83-89) which calls `ensureWorkspace()` (`src/lib/auth.ts:324-335`) and re-runs
  `handleAuthResult`.
- **What's actually missing/weak:** (a) no escape hatch if retry fails repeatedly — the user is stuck
  re-clicking the same button with no alternate path (contact support, sign out and try a different
  account, etc.); (b) the notice text doesn't explain *why* it might be failing or what the user should
  do if retry doesn't work; (c) no visible error detail from the underlying `WORKSPACE_SETUP_ERROR`
  (`src/lib/auth.ts:58`) beyond the generic message — a transient network blip and a genuine backend
  outage look identical to the user; (d) `/business` page has its own `handleRepairWorkspace`
  (`src/app/(app)/business/page.tsx:120-132`) that is a near-duplicate of login's retry flow — the two
  should share one component/hook instead of two separately-maintained copies.

**Member-management UI (`src/app/(app)/business/page.tsx`):**
- Lines 81-118 + 229-287: a full "Add user" form already exists — email, name, role (counter/viewer/
  admin dropdown), optional temp password, wired to `createBusinessMember`
  (`src/lib/auth.ts:364-406` → `POST /api/businesses/members`, `src/app/api/businesses/members/route.ts`).
  Handles all three response states already (`passwordSet` / `createdAuthUser` / linked-existing) with
  distinct notices (line 110-116).
- Lines 187-202: the membership list shows the CALLER's own memberships (business name, their own role,
  a Select button) — this is "which businesses am I in", not "who else is in this business".
- **What's actually missing:** (a) **no roster of a business's OTHER members** — a business owner can add
  a user but cannot see, edit the role of, or remove any existing member; there is no
  `listBusinessMembers(businessId)` equivalent to `listMemberships()` (which is scoped to the caller's own
  `userId`, not a given `businessId`) and no matching API route; (b) no role-edit or remove-member action
  at all (`src/app/api/businesses/members/route.ts` scout shows POST/create only — confirm no PATCH/DELETE
  exists); (c) the "Add user" form is only reachable from `/business`, which a user only sees when they
  have 0 memberships or are actively choosing a workspace — there's no persistent "Team" or "Members"
  settings section once inside `/scan` (Settings page has no member roster either).

### Exact change
**3a. Recovery UX rewrite (`src/app/login/page.tsx` + `src/lib/auth.ts`):**
1. Extract a shared `useWorkspaceRecovery()` hook (new file `src/lib/workspaceRecovery.ts` or inline in
   `src/lib/auth.ts`) wrapping `ensureWorkspace()` with a retry-attempt counter.
2. After 2 failed retries, escalate the login-page UI: keep the retry button but add a secondary "Sign
   out and try again" link and a short explanation ("This usually resolves within a minute. If it keeps
   happening, sign out and back in, or contact support at [email]."). Use `WORKSPACE_SETUP_ERROR`'s
   underlying reason if `provisionBusiness`/`requestProvision` (`src/lib/auth.ts:179-212`) can surface a
   `reason` code (it can — `ProvisionResponse.reason` already carries `workspace_unavailable` etc. per
   `src/services/auth/provisioningTypes.ts`) instead of collapsing everything to one generic string.
3. Replace `/business`'s `handleRepairWorkspace` (page.tsx:120-132) with the same shared hook so the two
   surfaces stay in sync.

**3b. Minimal member screen:**
1. New API route `src/app/api/businesses/[businessId]/members/route.ts` — `GET` (list, membership-scoped:
   caller must have a membership row for this businessId; return role for each member — email needs a
   join against `UserProfile`/Auth records, so return `{ userId, role, name? }` at minimum), and reuse the
   existing POST-equivalent semantics from `src/app/api/businesses/members/route.ts` for role-update
   (`PATCH`) and remove (`DELETE`), gated to `owner`/`admin` roles only (the existing POST route's
   `owner_required` reason code, `src/lib/auth.ts:399`, shows the precedent to follow — confirm exact
   role gate in `route.ts` before copying).
2. New section on the existing `/business` page (or a new `/business/[businessId]/members` route if the
   page is getting crowded — Effort call: reuse `/business` first, split out only if the page exceeds
   ~300 lines) rendering the roster with an inline role `<select>` (reuse the same
   `counter/viewer/admin` options already at page.tsx:261-264) and a "Remove" button per row (never
   allow removing the last `owner`).
3. Client functions `listBusinessMembers`, `updateMemberRole`, `removeMember` added to `src/lib/auth.ts`
   alongside the existing `createBusinessMember`, following its exact fetch/Bearer-token/error-shape
   pattern (lines 364-406).

### Test plan
- 3a: extend `src/app/login/page.tsx`'s existing test coverage (grep for a login test file — check
  `src/app/login/page.test.tsx` if present) to cover the retry-count escalation and the reason-code
  passthrough; extend `src/app/(app)/business/business.recovery.test.tsx` (already exists, covers repair
  flow) for the shared-hook refactor — must not regress its current assertions.
- 3b: new route tests (mirror `src/app/api/businesses/members/route.test.ts` which already exists for
  POST) for GET/PATCH/DELETE — non-member 403, non-owner/admin 403 on mutate, last-owner-removal blocked;
  component test for the roster rendering + role change + remove confirm; `test:firebase` pass if
  Firestore rules need a matching update for list-members reads.
- Browser proof (`qa:bots:*`, customer-facing per CLAUDE.md gate): owner adds a member, changes their
  role, removes them, screenshot each step.

### Effort: **M** (3a is a focused rewrite of an existing small flow; 3b is new CRUD UI + 3 new
route handlers, but reuses the well-established add-member pattern already proven in the codebase)

### Owner-gated?
No — no billing, no prod credentials, no real customer data. Standard live-auth-backed feature work,
now unblocked since the auth flip is verified done.

---

## Summary

| Spec | Effort | Owner-gated |
|---|---|---|
| 1. Stripe Payment Link manual gating | M | Partial — design/build No; flipping a real business's plan status after a real payment is Yes |
| 2. Per-tenant decode cost metering | M | No |
| 3. Signup/member-management polish | M | No |

**Total effort estimate:** M+M+M — three medium items, no single-file trivial task among them; realistic
for one build wave with 2-3 parallel executors (the three specs touch almost entirely disjoint files:
Spec 1 touches `BusinessContextGate.tsx` + new entitlement routes; Spec 2 touches `ai-lookup/route.ts` +
`aiSpendGuard.ts` + Settings; Spec 3 touches `login/page.tsx` + `business/page.tsx` + new member routes —
the only shared-file risk is all three editing `src/services/db/types.ts`'s `Business` interface, so
that one edit should land first/atomically before the three specs branch out).

**Single highest-risk item:** Spec 1 (Stripe gating). It is the only spec that can lock a real paying
customer out of the app if the entitlement default is wrong (the "trial vs past_due default for new
signups" open question is unresolved and must be answered before any real customer flows through it) and
it is the only spec with a genuine owner-gated action downstream (flipping a live business's plan status
after real money changes hands). Specs 2 and 3 are pure app-logic with safe/backward-compatible defaults
and zero risk of locking anyone out.

**Corrections to the master plan surfaced by this scout (report upstream before the build wave starts):**
1. Spec 2's "today capped only globally" framing is stale — per-account metering already exists and is
   wired into both ai-lookup paths; the real gap is plan-tier differentiation + owner visibility, not
   metering from scratch.
2. Spec 3's "Depends on auth flip" gate is resolved — the auth flip is verified live in production per
   master plan §3, so this item should move to ungated/ready, not conditional.
3. Both Spec 1 (member-management already has an Add-user form) and Spec 3 have real prior art in the
   codebase; neither is a greenfield build.
