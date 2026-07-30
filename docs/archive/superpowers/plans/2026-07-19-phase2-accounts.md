# Phase 2 - Accounts and the Two-Database Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the scanner from an open-access demo into a real multi-account product: complete the auth surface (Google + password reset), thread the authenticated `businessId` through a single per-uid persist namespace with sign-out clearing and an owner-initiated legacy adopt flow, close the `/api/ai-lookup` server-trust holes (D4, including scanContext and the non-public auto-count flag) with per-account quotas charged on the exact paid-compute signal, gate destructive actions behind the owner PIN, and define the resolver tenant-truth vs master-truth interface, all behind a coarse `AUTH_MODE = mock | live` chokepoint whose default (`mock`) keeps every existing test green.

**Architecture:** One new `authMode.ts` chokepoint collapses ALL THREE duplicated reads of the login-wall concept (`AuthGuard.tsx:13`, `BusinessContextGate.tsx:20`, `Nav.tsx:50`) into a single source. The scan-store persist key becomes per-uid (`sis-scan-${uid}`) via a runtime `persist.setOptions` re-point, with an OWNER-INITIATED adopt step for the legacy `sis-scan-v1` blob (copy then delete, never an automatic first-sign-in inheritance) and a full sign-out reset that removes the per-uid key, re-points persist to the anon key, and clears `settings`/`needsReviewQueue`/`scanFeed`/`finalCounts` (which `setBusinessContext` never reset). Server trust copies the working `resolve-scan/route.ts` auth pattern into `ai-lookup`, always recomputes `codeType`, clamps `confidenceThreshold`, makes `scanContext` and `autoCountNonPublicWithEvidence` server-authoritative in live mode, and layers a per-account daily quota that charges on the SAME signal as the global paid charge (a `paidComputeCharged` boolean threaded from the pipeline's single `chargeDailySlot` site). `mock` mode preserves today's open-demo behavior verbatim so demos and tests never need credentials.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Tailwind v4 / Zustand (+ persist) / Firebase (Auth, Firestore, emulator via `@firebase/rules-unit-testing`) / Vitest (node + jsdom projects) / Playwright.

## Global Constraints

- Local commits only. NEVER push, deploy, or promote. No `git push` in any step.
- `AUTH_MODE` default is `mock`. `mock` = current open-demo behavior (DEMO_BUSINESS_ID, `ai-lookup` unauthenticated, global daily cap, e2e/QA-bot substrate untouched). `live` requires auth. Every existing test runs in `mock` and MUST stay green.
- Tests never call live paid providers. Mock `fetch`/`page.route`; the Playwright webServer runs `IS_E2E=1`. Automated suites cost $0.
- No em dashes or en dashes anywhere, not in plan prose, code, comments, or user-facing copy. Use normal punctuation (commas, periods, parentheses, " - " hyphen-with-spaces only where a literal ASCII hyphen reads fine).
- Brand-neutral: introduce NO uncleared product name in new user-facing copy. There is NO `PRODUCT_NAME` constant in `src/` yet (grep confirms it lives only in docs/e2e); do NOT create one here (that is deferred naming work). New copy uses generic phrasing ("your account", "this workspace"). Leave the existing `login/page.tsx` "Smart Inventory Scanner" heading untouched (out of scope; not a regression this phase introduces).
- Keep services pure and testable: no React / `next/*` imports in `src/services`. New store logic stays in `src/stores`.
- Keep the 4-role model (`owner|admin|counter|viewer`) exactly as-is. Do NOT edit `firestore.rules` role logic. Do NOT flip `SHOW_ADVANCED_ACTIONS` (markWrong stays UI-dead by owner decision; prove PIN gating via `window.__scanStore` per the Phase 1 ratified precedent).
- Do NOT touch the P1 ledger machinery or `firebaseSyncTarget.ts` (already tenant-correct by path construction). The decode pipeline's rung/cache/cap logic stays untouched EXCEPT the single Task 10 change: a `paidComputeCharged` boolean set at the pipeline's one existing `chargeDailySlot` call site (`pipeline.ts:1229`) and carried in the computed result, so the route's per-account charge rides the identical signal as the global charge (L12: one charge per genuine compute, never a second path).
- DEFERRED to P6 (do NOT build here): account-wide export archive, hard account deletion, plan/entitlements shape.
- The E2E-bypass flag (`isAuthBypassEnabled`) and the emulator flag (`NEXT_PUBLIC_FIREBASE_USE_EMULATOR`) are orthogonal to `AUTH_MODE` and stay separate.

## Scout facts that override the master plan (resolved here)

1. Master plan calls P2 auth a "slot fill-in" / "completion." Scout-auth confirms Google sign-in and password reset are **100% net-new** (zero `GoogleAuthProvider`/`sendPasswordResetEmail` in the repo) and that introducing `AUTH_MODE` is a **refactor of 3 duplicated env reads** (`AuthGuard.tsx:13`, `BusinessContextGate.tsx:20`, `Nav.tsx:50`), not an additive flag. Resolution: Track 1 + Track 3 migrate ALL THREE reads (Tasks 4 and 8); leaving any one behind would let `AUTH_MODE=live` raise the login wall while `BusinessContextGate` still computes `cloud=false`, so context/rehydrate never fire and every authed user shares the anon persist key (the exact leak this phase kills).
2. Master plan implies sign-out state clearing and tenancy is mostly a persist-key rename. All three scouts confirm `setBusinessContext` never resets `settings` or `needsReviewQueue` (and never touches `scanFeed`), and `loadBusinessData` never fetches them, so the isolation acceptance test fails without **new loader + reset code**. Resolution: Task 7 resets `settings`/`needsReviewQueue`/`scanFeed`/`finalCounts` on every context switch, wider than a rename, with a one-user-two-businesses switch test.
3. Master plan describes `catalogEntries` master-append as something P2 "completes." Scout-rules confirms the **server-side Admin-SDK writer does not exist anywhere in `src/`** (only the deny-side rule + read-only `getByBarcode`). Resolution: P2 only extends the passing deny test and defines the interface; the master-append WRITE path is out of P2 scope (P5 builds it). This plan asserts the read-only invariant, it does not build a writer.
4. Master plan says "per-account daily quotas layered on the global cap." Scout-rules confirms `aiSpendGuard.ts` has **zero businessId dimension** and the correct seam is `readDailyUsed`/`chargeDailySlot` with exactly one charge per genuine compute (L12). Resolution: Task 10 adds a second `ai_daily_cap:<businessId>:<dateKey>` counter gated at the SAME point, and the decode path's account charge is gated on a `paidComputeCharged` boolean set at the pipeline's single existing global-charge site (never on `cached:false`, which is also true for free rung-0 corpus/retail/learned hits at `pipeline.ts:542/572/586`).
5. P1-handoff landmine: legacy v7 localStorage carries provisional feed rows with literal `quantityDelta: 0`, and `applyScanEventOnce`'s `?? 1` does not correct a non-nullish 0. Since Task 6 bumps the persist version to 8 for the namespace migration anyway, it FOLDS IN the `quantityDelta: 0 -> 1` normalization on migrated legacy data (stated explicitly in Task 6). This is the only version bump P2 makes; it stays above the `< 5` destructive-reset boundary.

---

## File Structure

**Track 1 - Auth surface (disjoint files):**
- Create `src/services/auth/authMode.ts` - the single `AUTH_MODE` chokepoint (`getAuthMode()`, `isLiveAuth()`, `isOpenAccess()`).
- Modify `src/lib/auth.ts` - add `signInWithGoogle`, `sendResetEmail`.
- Modify `src/app/login/page.tsx` - Google button + "Forgot password?" flow.
- Modify `src/components/AuthGuard.tsx` - consume `authMode.ts` instead of a local `OPEN_ACCESS` read.

**Track 2 - Server trust (disjoint files):**
- Create `src/services/security/decodePolicy.ts` - pure `clampConfidenceThreshold` (+ its test).
- Modify `src/app/api/ai-lookup/route.ts` - always recompute `codeType`; clamp threshold; server-authoritative `scanContext`/`autoCountNonPublicWithEvidence` in live mode; live-mode auth + per-account quota gate.
- Modify `src/server/decode/pipeline.ts` - MINIMAL: `paidComputeCharged` boolean set at the single `chargeDailySlot` site (:1229), required on the computed result variant (tsc then finds every computed return site).
- Modify `src/services/security/aiSpendGuard.ts` - add `perAccountDailyKey`, `readDailyUsedForAccount`, `chargeDailySlotForAccount`.
- Modify `src/services/db/firebase/tenantIsolation.rules.test.ts` - extend the passing `catalogEntries` deny test + seed and deny `retailCatalogEntries`.

**Track 3 - Store tenancy (all inside scanStore.ts + its persist/reset helpers, serialized within the track):**
- Create `src/stores/scanReset.ts` - pure `emptyTenantState()` used by sign-out reset and context switch.
- Create `src/stores/scanPersistNamespace.ts` - `persistKeyForUid`, `hasLegacyBlob`, `migrateLegacyBlobOnce` (copy + DELETE legacy).
- Modify `src/stores/scanStore.ts` - per-uid persist key via a runtime `persist.setOptions` re-point (the `:5260` name literal is fixed at store creation; `deps.persistName` only drives the initial `_hasHydrated` at `:1105`, it cannot rename the key), `resetForSignOut` + `rehydrateForUid` + `adoptLegacyLocalData` actions, and `setBusinessContext` reset of `settings`/`needsReviewQueue`/`scanFeed`/`finalCounts`.
- Modify `src/components/BusinessContextGate.tsx` - consume the chokepoint (`cloud = isLiveAuth() && isFirebaseBackend()`), owner-initiated legacy adopt banner, per-uid rehydrate before `setBusinessContext`.
- Modify `src/lib/selectedBusiness.ts` - no code change; its existing dead `clearSelectedBusinessId()` gets its first caller (the store's sign-out reset).
- Modify `src/components/Nav.tsx` and `src/app/(app)/business/page.tsx` - sign-out calls the new store reset before redirect; Nav's visibility conditional migrates to the chokepoint.

**Sync point S1 (after Task 2):** `authMode.ts` exists; Tracks 1, 2, 3 all consume it. Tasks that import it (4, 8, 10) depend on Task 2.

**Track 4 - Resolver tier interface + destructive-action guard (disjoint from 1-3):**
- Modify `src/services/aliasMatcher.ts` - add `resolveScanToProductTiered` (interface only; short-circuit preserved, no conflict logic, P5 owns that).
- Create `src/services/security/destructiveGuard.ts` - pure `requiresOwnerPin(action)` policy.
- Modify `src/components/FinalCountTable.tsx` and `src/app/(app)/settings/page.tsx` - PIN prompt before markWrong-class / clear-cache / count-removal, PRESERVING the existing clear-cache body (cacheMsg + the AM-R9 1400ms reload).

---

## Parallel-track map (execution mechanics: SINGLE CHECKOUT)

Tracks T1-T4 run as parallel subagents in the ONE existing checkout, each editing only its verified-disjoint files listed below. ALL `git add` / `git commit` operations are performed by the ORCHESTRATOR, serially, after reviewing each task's report; subagents implement + run tests + report, they do NOT commit (the commit steps inside each task below are executed by the orchestrator). Within-track serialization holds (T3: Task 6 -> 7 -> 8; T4: Task 14 -> 15). Worktrees were considered and REJECTED for this phase: on Windows each worktree needs its own `node_modules` install (no sharing), costing minutes per track for zero isolation benefit given the disjoint-file guarantee.

| Track | Tasks | Primary files (disjoint across tracks) |
|---|---|---|
| **T2-chokepoint (must land first)** | Task 1, 2 | `src/services/auth/authMode.ts` (+ test) |
| **T1 auth surface** | Task 3, 4, 5 | `src/lib/auth.ts`, `src/app/login/page.tsx`, `src/components/AuthGuard.tsx` |
| **T2 server trust** | Task 9, 10, 11, 12 | `src/services/security/decodePolicy.ts`, `src/app/api/ai-lookup/route.ts`, `src/server/decode/pipeline.ts`, `src/services/security/aiSpendGuard.ts`, `tenantIsolation.rules.test.ts` |
| **T3 store tenancy** | Task 6, 7, 8 | `src/stores/scanReset.ts`, `src/stores/scanPersistNamespace.ts`, `scanStore.ts`, `BusinessContextGate.tsx`, `selectedBusiness.ts`, `Nav.tsx`, `business/page.tsx` |
| **T4 resolver + guard** | Task 13, 14, 15 | `src/services/aliasMatcher.ts`, `src/services/security/destructiveGuard.ts`, `FinalCountTable.tsx`, `settings/page.tsx` |
| **T5 integration proof** | Task 16, 17 | `e2e/p2-accounts.spec.ts`, replay test, full gate sweep |

**Dependency edges:**
- Task 1 -> Task 2 (test then impl).
- Task 2 (S1) -> Task 4 (AuthGuard reads authMode), Task 8 (store + BusinessContextGate + Nav read authMode), Task 10 (route reads authMode). These three tracks each consume S1 but touch disjoint files, so they run in parallel AFTER Task 2 merges.
- Within T3, Task 6 -> Task 7 -> Task 8 SERIALIZE (all edit `scanStore.ts` or its consumers).
- Within T4, Task 14 -> Task 15 SERIALIZE (Task 15's two UI files import `destructiveGuard.ts` from Task 14); Task 13 (aliasMatcher) is independent and may run parallel to 14/15.
- Within T2, Task 9 (decodePolicy) and Task 11 (aiSpendGuard) are independent; Task 10 (route.ts + pipeline.ts) depends on 9 + 11 + Task 2; Task 12 (rules test) is independent.
- T5 (16, 17) depends on ALL of T1/T2/T3/T4 merged (final integration + acceptance proof).

---

### Task 1: AUTH_MODE chokepoint - failing test

**Track:** T2-chokepoint. **Depends on:** none.

**Files:**
- Test: `src/services/auth/authMode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/auth/authMode.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { getAuthMode, isLiveAuth, isOpenAccess } from "./authMode";

const ORIG = { ...process.env };
afterEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
  process.env.NEXT_PUBLIC_REQUIRE_LOGIN = ORIG.NEXT_PUBLIC_REQUIRE_LOGIN;
});

describe("authMode chokepoint", () => {
  it("defaults to mock when nothing is set", () => {
    delete process.env.NEXT_PUBLIC_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_REQUIRE_LOGIN;
    expect(getAuthMode()).toBe("mock");
    expect(isLiveAuth()).toBe(false);
    expect(isOpenAccess()).toBe(true);
  });

  it("is live when NEXT_PUBLIC_AUTH_MODE=live", () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "live";
    expect(getAuthMode()).toBe("live");
    expect(isLiveAuth()).toBe(true);
    expect(isOpenAccess()).toBe(false);
  });

  it("legacy NEXT_PUBLIC_REQUIRE_LOGIN=1 maps to live (back-compat)", () => {
    delete process.env.NEXT_PUBLIC_AUTH_MODE;
    process.env.NEXT_PUBLIC_REQUIRE_LOGIN = "1";
    expect(getAuthMode()).toBe("live");
    expect(isOpenAccess()).toBe(false);
  });

  it("explicit AUTH_MODE wins over the legacy flag", () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
    process.env.NEXT_PUBLIC_REQUIRE_LOGIN = "1";
    expect(getAuthMode()).toBe("mock");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/services/auth/authMode.test.ts`
Expected: FAIL with "Cannot find module './authMode'".

---

### Task 2: AUTH_MODE chokepoint - implementation (SYNC POINT S1)

**Track:** T2-chokepoint. **Depends on:** Task 1.

**Files:**
- Create: `src/services/auth/authMode.ts`
- Test: `src/services/auth/authMode.test.ts` (from Task 1)

**Interfaces:**
- Produces: `type AuthMode = "mock" | "live"`; `getAuthMode(): AuthMode`; `isLiveAuth(): boolean`; `isOpenAccess(): boolean`. Consumed by Tasks 4, 8, 10.

- [ ] **Step 1: Write the implementation**

```ts
// src/services/auth/authMode.ts
// Single source of truth for the coarse auth mode. Collapses the three duplicated reads of
// NEXT_PUBLIC_REQUIRE_LOGIN (AuthGuard.tsx:13, BusinessContextGate.tsx:20, Nav.tsx:50) plus the
// backend flag interplay into one place. ALL THREE consumers must migrate here in the same phase:
// leaving BusinessContextGate on the old read while AuthGuard goes live would raise the login wall
// but keep cloud=false, so business context and per-uid persist would never engage for authed users.
//
//   mock = today's open-demo behavior: no login wall, DEMO_BUSINESS_ID, ai-lookup unauthenticated,
//          global daily cap, e2e/QA-bot substrate untouched. Demos and tests need no credentials.
//   live = auth required: login wall on, membership-derived businessId, ai-lookup authenticated + per-account cap.
//
// Orthogonal (do NOT fold in here): isAuthBypassEnabled() (E2E/test bypass) and
// NEXT_PUBLIC_FIREBASE_USE_EMULATOR (dev-environment selection). Those stay separate on purpose.

export type AuthMode = "mock" | "live";

/**
 * Resolve the auth mode. Precedence:
 *   1. NEXT_PUBLIC_AUTH_MODE=mock|live (explicit, wins).
 *   2. Legacy NEXT_PUBLIC_REQUIRE_LOGIN=1 -> "live" (back-compat so preview/emulator configs keep working).
 *   3. Default "mock".
 */
export function getAuthMode(): AuthMode {
  const explicit = (process.env.NEXT_PUBLIC_AUTH_MODE ?? "").trim().toLowerCase();
  if (explicit === "live" || explicit === "mock") return explicit;
  if (process.env.NEXT_PUBLIC_REQUIRE_LOGIN === "1") return "live";
  return "mock";
}

export function isLiveAuth(): boolean {
  return getAuthMode() === "live";
}

/** Open access = mock mode: no login wall, no business-context gate, demo substrate. */
export function isOpenAccess(): boolean {
  return getAuthMode() === "mock";
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run test -- src/services/auth/authMode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add src/services/auth/authMode.ts src/services/auth/authMode.test.ts
git commit -m "feat(auth): single AUTH_MODE mock|live chokepoint (S1)"
```

---

### Task 3: Google sign-in + password reset in auth.ts

**Track:** T1. **Depends on:** none (net-new, disjoint from Track 2 chokepoint).

**Files:**
- Modify: `src/lib/auth.ts` (add imports + two exports after `signUp`, around `auth.ts:64`)
- Test: `src/lib/auth.google.test.ts`

**Interfaces:**
- Consumes: `getFirebaseAuth` (`@/lib/firebaseClient`), `isAuthBypassEnabled`, `ensureUserProfile` (already in file).
- Produces: `signInWithGoogle(): Promise<{ error: string | null }>`; `sendResetEmail(email: string): Promise<{ error: string | null }>`. Consumed by Task 5 (login page).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth.google.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const signInWithPopup = vi.fn();
const sendPasswordResetEmail = vi.fn();
const GoogleAuthProvider = vi.fn();

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithPopup: (...a: unknown[]) => signInWithPopup(...a),
  sendPasswordResetEmail: (...a: unknown[]) => sendPasswordResetEmail(...a),
  GoogleAuthProvider,
}));
vi.mock("@/lib/firebaseClient", () => ({ getFirebaseAuth: () => ({}), getDb: () => ({}) }));
vi.mock("@/services/auth/authBypass", () => ({ isAuthBypassEnabled: () => false }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(), setDoc: vi.fn(), getDocs: vi.fn(), query: vi.fn(),
  collection: vi.fn(), where: vi.fn(), serverTimestamp: vi.fn(),
}));

import { signInWithGoogle, sendResetEmail } from "./auth";

beforeEach(() => { signInWithPopup.mockReset(); sendPasswordResetEmail.mockReset(); });

describe("signInWithGoogle", () => {
  it("returns no error on success and ensures a profile", async () => {
    signInWithPopup.mockResolvedValue({ user: { uid: "u1", email: "a@b.co", displayName: "A" } });
    const res = await signInWithGoogle();
    expect(res.error).toBeNull();
    expect(signInWithPopup).toHaveBeenCalledOnce();
  });
  it("returns the error message on failure", async () => {
    signInWithPopup.mockRejectedValue(new Error("popup closed"));
    const res = await signInWithGoogle();
    expect(res.error).toBe("popup closed");
  });
});

describe("sendResetEmail", () => {
  it("returns no error on success", async () => {
    sendPasswordResetEmail.mockResolvedValue(undefined);
    const res = await sendResetEmail("a@b.co");
    expect(res.error).toBeNull();
    expect(sendPasswordResetEmail).toHaveBeenCalledOnce();
  });
  it("returns the error message on failure", async () => {
    sendPasswordResetEmail.mockRejectedValue(new Error("no user"));
    const res = await sendResetEmail("x@y.co");
    expect(res.error).toBe("no user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/auth.google.test.ts`
Expected: FAIL with "signInWithGoogle is not a function" / import error.

- [ ] **Step 3: Add the Firebase imports**

In `src/lib/auth.ts`, extend the `firebase/auth` import block (currently `auth.ts:3-9`) to add three names:

```ts
import {
  type User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail,
} from "firebase/auth";
```

- [ ] **Step 4: Add the two exports after `signUp` (after `auth.ts:64`)**

```ts
/** Google sign-in via popup. On success, ensures the user's profile doc exists (same as email sign-up). */
export async function signInWithGoogle(): Promise<{ error: string | null }> {
  try {
    const cred = await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    await ensureUserProfile(cred.user);
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

/** Send a Firebase password-reset email. Errors (e.g. unknown address) are returned, not thrown. */
export async function sendResetEmail(email: string): Promise<{ error: string | null }> {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email.trim());
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/lib/auth.google.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.google.test.ts
git commit -m "feat(auth): Google sign-in and password-reset email (net-new)"
```

---

### Task 4: AuthGuard consumes the AUTH_MODE chokepoint

**Track:** T1. **Depends on:** Task 2 (S1).

**Files:**
- Modify: `src/components/AuthGuard.tsx:13` (replace the local `OPEN_ACCESS` env read)
- Test: `src/components/AuthGuard.authmode.test.tsx`

**Interfaces:**
- Consumes: `isOpenAccess` from `@/services/auth/authMode` (Task 2).
- Note: this migrates read 1 of 3. Reads 2 and 3 (`BusinessContextGate.tsx:20`, `Nav.tsx:50`) migrate in Task 8 (Track 3, same phase); the chokepoint is only complete when all three are done.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/AuthGuard.authmode.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  onAuthChange: () => () => {},
  isAuthBypassEnabled: () => false,
}));
const isOpenAccess = vi.fn();
vi.mock("@/services/auth/authMode", () => ({ isOpenAccess: () => isOpenAccess() }));

import { AuthGuard } from "./AuthGuard";

describe("AuthGuard + AUTH_MODE", () => {
  it("renders children immediately in mock/open-access mode", () => {
    isOpenAccess.mockReturnValue(true);
    render(<AuthGuard><div data-testid="child">hi</div></AuthGuard>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
  it("hides children (loading) in live mode until a session resolves", () => {
    isOpenAccess.mockReturnValue(false);
    render(<AuthGuard><div data-testid="child">hi</div></AuthGuard>);
    expect(screen.queryByTestId("child")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/AuthGuard.authmode.test.tsx`
Expected: FAIL (AuthGuard still reads `NEXT_PUBLIC_REQUIRE_LOGIN`, not the mocked `isOpenAccess`).

- [ ] **Step 3: Edit AuthGuard.tsx**

Replace the top of `src/components/AuthGuard.tsx`. Change the import at `AuthGuard.tsx:5` region and delete the `OPEN_ACCESS` const at `:13`:

```tsx
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, onAuthChange, isAuthBypassEnabled } from "@/lib/auth";
import { isOpenAccess } from "@/services/auth/authMode";

// Client-side gate for protected pages. In mock (open-access) mode children render immediately.
// In live mode it checks a real Firebase auth session (async) and redirects to /login when there is none.
// The E2E/test bypass keeps existing Playwright specs green and is impossible in production.

type GateState = "loading" | "authed" | "anon";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>(() =>
    isAuthBypassEnabled() || isOpenAccess() ? "authed" : "loading",
  );

  useEffect(() => {
    if (isAuthBypassEnabled() || isOpenAccess()) return;
    let active = true;
    getSession().then((s) => {
      if (active) setState(s ? "authed" : "anon");
    });
    const unsub = onAuthChange((s) => {
      if (active) setState(s ? "authed" : "anon");
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (state === "anon") router.replace("/login");
  }, [state, router]);

  if (state !== "authed") return null;
  return <>{children}</>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/AuthGuard.authmode.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/AuthGuard.tsx src/components/AuthGuard.authmode.test.tsx
git commit -m "refactor(auth): AuthGuard reads AUTH_MODE chokepoint (read 1 of 3)"
```

---

### Task 5: Login page - Google button + Forgot password flow

**Track:** T1. **Depends on:** Task 3.

**Files:**
- Modify: `src/app/login/page.tsx`
- Test: `src/app/login/login.reset.test.tsx`

**Interfaces:**
- Consumes: `signInWithGoogle`, `sendResetEmail` (Task 3), existing `signInWithPassword`/`signUp`/`isAuthBypassEnabled`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/login/login.reset.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const sendResetEmail = vi.fn();
const signInWithGoogle = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signInWithGoogle: (...a: unknown[]) => signInWithGoogle(...a),
  sendResetEmail: (...a: unknown[]) => sendResetEmail(...a),
  isAuthBypassEnabled: () => false,
}));

import LoginPage from "./page";

beforeEach(() => { sendResetEmail.mockReset(); signInWithGoogle.mockReset(); });

describe("login page reset + google", () => {
  it("shows a confirmation notice after requesting a reset", async () => {
    sendResetEmail.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByTestId("forgot-password"));
    fireEvent.click(screen.getByTestId("send-reset"));
    await waitFor(() => expect(sendResetEmail).toHaveBeenCalledWith("a@b.co"));
    expect(await screen.findByTestId("login-notice")).toBeInTheDocument();
  });

  it("calls Google sign-in when the Google button is clicked", async () => {
    signInWithGoogle.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.click(screen.getByTestId("login-google"));
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledOnce());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/app/login/login.reset.test.tsx`
Expected: FAIL ("Unable to find element by testId login-google").

- [ ] **Step 3: Edit login/page.tsx**

Replace the import line and `handleSubmit` region, and add the Google button + reset UI. Full new file body:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithPassword, signUp, signInWithGoogle, sendResetEmail, isAuthBypassEnabled } from "@/lib/auth";

// Firebase email/password + Google login. In E2E/test bypass mode (never production) the form just routes
// to /scan so existing Playwright specs keep working without a live auth backend.
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (isAuthBypassEnabled()) {
      router.replace("/scan");
      return;
    }
    setBusy(true);
    if (mode === "reset") {
      const res = await sendResetEmail(email);
      setBusy(false);
      if (res.error) { setError(res.error); return; }
      setNotice("If that address has an account, a reset link is on its way.");
      return;
    }
    const res = mode === "signup" ? await signUp(email, password) : await signInWithPassword(email, password);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    router.replace(mode === "signup" ? "/business" : "/scan");
  }

  async function handleGoogle() {
    setError("");
    setNotice("");
    if (isAuthBypassEnabled()) { router.replace("/scan"); return; }
    setBusy(true);
    const res = await signInWithGoogle();
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    router.replace("/business");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">Smart Inventory Scanner</h1>
        <p className="mt-1 text-base text-zinc-600">
          {mode === "signin" ? "Sign in to your account." : mode === "signup" ? "Create an account." : "Reset your password."}
        </p>

        <label className="mt-5 block text-base font-medium text-zinc-800" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="login-email"
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base"
        />

        {mode !== "reset" && (
          <>
            <label className="mt-3 block text-base font-medium text-zinc-800" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="login-password"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-3 text-base"
            />
          </>
        )}

        {error && <p className="mt-3 text-base text-red-600" data-testid="login-error">{error}</p>}
        {notice && <p className="mt-3 text-base text-green-700" data-testid="login-notice">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          data-testid={mode === "reset" ? "send-reset" : "login-button"}
          className="mt-5 inline-flex min-h-[48px] w-full items-center justify-center rounded-lg bg-blue-600 px-4 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Please wait..." : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
        </button>

        {mode !== "reset" && (
          <button
            type="button"
            onClick={handleGoogle}
            disabled={busy}
            data-testid="login-google"
            className="mt-3 inline-flex min-h-[48px] w-full items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 text-base font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
          >
            Continue with Google
          </button>
        )}

        <div className="mt-3 flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setNotice(""); }}
            className="text-blue-700 hover:underline"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
          {mode !== "reset" ? (
            <button
              type="button"
              data-testid="forgot-password"
              onClick={() => { setMode("reset"); setError(""); setNotice(""); }}
              className="text-blue-700 hover:underline"
            >
              Forgot password?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setMode("signin"); setError(""); setNotice(""); }}
              className="text-blue-700 hover:underline"
            >
              Back to sign in
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/app/login/login.reset.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/login/page.tsx src/app/login/login.reset.test.tsx
git commit -m "feat(auth): login page Google button and password-reset flow"
```

---

### Task 6: Per-uid persist namespace + owner-adopt legacy migration (+ quantityDelta:0 fold-in)

**Track:** T3. **Depends on:** none. **SERIALIZES before Task 7, 8 (same file family).**

**Files:**
- Modify: `src/stores/scanStore.ts` (persist config around `:5258-5281`; version literal at `:5261`; migrate non-destructive branch at `:5249-5255`)
- Create: `src/stores/scanPersistNamespace.ts` (pure helpers, unit-testable without the store)
- Test: `src/stores/scanPersistNamespace.test.ts`

**Interfaces:**
- Produces: `persistKeyForUid(uid: string | null): string` (returns `"sis-scan-v1"` for null/anon so the mock/demo path is byte-for-byte unchanged; `"sis-scan-<uid>"` otherwise); `hasLegacyBlob(storage: Storage): boolean`; `migrateLegacyBlobOnce(uid: string, storage: Storage): void` (copies `sis-scan-v1` into the per-uid key exactly once, normalizing any `quantityDelta: 0` feed rows to `1`, then DELETES `sis-scan-v1` after a successful copy so it can never be inherited by a second sign-in or leak later). Consumed by Task 8.
- Ownership rule (security ruling): `migrateLegacyBlobOnce` must only ever be called from an explicit OWNER-INITIATED adopt action (Task 8's adopt banner), never automatically on first sign-in; an automatic copy would hand user A's inventory to whichever user signs in first on a shared browser.

- [ ] **Step 1: Write the failing test**

```ts
// src/stores/scanPersistNamespace.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { persistKeyForUid, hasLegacyBlob, migrateLegacyBlobOnce } from "./scanPersistNamespace";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe("persistKeyForUid", () => {
  it("keeps the legacy global key for anon/mock (null uid)", () => {
    expect(persistKeyForUid(null)).toBe("sis-scan-v1");
  });
  it("namespaces by uid for a signed-in user", () => {
    expect(persistKeyForUid("abc123")).toBe("sis-scan-abc123");
  });
});

describe("hasLegacyBlob", () => {
  it("reports whether the legacy global blob exists", () => {
    const s = new MemStorage();
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(false);
    s.setItem("sis-scan-v1", "{}");
    expect(hasLegacyBlob(s as unknown as Storage)).toBe(true);
  });
});

describe("migrateLegacyBlobOnce", () => {
  let s: MemStorage;
  beforeEach(() => { s = new MemStorage(); });

  it("copies into the per-uid key, normalizes quantityDelta:0, and DELETES the legacy blob", () => {
    const legacy = {
      state: { scanFeed: [{ id: "e1", quantityDelta: 0 }, { id: "e2", quantityDelta: 3 }], businessId: "b1" },
      version: 7,
    };
    s.setItem("sis-scan-v1", JSON.stringify(legacy));
    migrateLegacyBlobOnce("abc123", s as unknown as Storage);
    const copied = JSON.parse(s.getItem("sis-scan-abc123")!);
    expect(copied.state.scanFeed[0].quantityDelta).toBe(1); // 0 -> 1
    expect(copied.state.scanFeed[1].quantityDelta).toBe(3); // untouched
    expect(s.getItem("sis-scan-v1")).toBeNull(); // consumed: cannot be double-inherited
  });

  it("does not overwrite an existing per-uid key and leaves the legacy blob alone (idempotent)", () => {
    s.setItem("sis-scan-v1", JSON.stringify({ state: { scanFeed: [] }, version: 7 }));
    s.setItem("sis-scan-abc123", JSON.stringify({ state: { marker: "keep" }, version: 8 }));
    migrateLegacyBlobOnce("abc123", s as unknown as Storage);
    expect(JSON.parse(s.getItem("sis-scan-abc123")!).state.marker).toBe("keep");
    expect(s.getItem("sis-scan-v1")).not.toBeNull(); // no copy happened, so nothing was consumed
  });

  it("is a no-op when there is no legacy blob", () => {
    migrateLegacyBlobOnce("abc123", s as unknown as Storage);
    expect(s.getItem("sis-scan-abc123")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/stores/scanPersistNamespace.test.ts`
Expected: FAIL ("Cannot find module './scanPersistNamespace'").

- [ ] **Step 3: Write the namespace helper**

```ts
// src/stores/scanPersistNamespace.ts
// Per-uid persist namespacing for the scan store. The anon/mock path keeps the legacy global key
// "sis-scan-v1" byte-for-byte so demos and every existing test are unaffected; a signed-in user gets
// their own "sis-scan-<uid>" key so two users on one browser never share persisted state.

const LEGACY_KEY = "sis-scan-v1";

export function persistKeyForUid(uid: string | null): string {
  return uid ? `sis-scan-${uid}` : LEGACY_KEY;
}

/** Whether the legacy pre-account global blob exists on this browser (drives the adopt banner). */
export function hasLegacyBlob(storage: Storage): boolean {
  return storage.getItem(LEGACY_KEY) !== null;
}

/**
 * OWNER-INITIATED adopt of the legacy global blob into the signed-in owner's per-uid key. Must only be
 * called from an explicit adopt action (BusinessContextGate's adopt banner), NEVER automatically on
 * sign-in: an automatic copy would hand the previous local inventory to whichever account signs in
 * first on a shared browser. Idempotent: never overwrites an existing per-uid key. On a successful
 * copy the legacy blob is DELETED so it cannot be inherited twice or leak to a later sign-in.
 * Folds in the P1-handoff fix: legacy v7 feed rows may carry a literal quantityDelta:0 (pre-D1) that
 * applyScanEventOnce's `?? 1` does not correct, so any 0 is normalized to 1 during the copy. The
 * copied blob keeps the legacy version (>= 5, above the destructive reset boundary), so
 * scanStoreMigrate runs normally on the copied key at next hydration.
 */
export function migrateLegacyBlobOnce(uid: string, storage: Storage): void {
  const targetKey = persistKeyForUid(uid);
  if (targetKey === LEGACY_KEY) return;
  if (storage.getItem(targetKey)) return; // already adopted: leave everything as-is
  const raw = storage.getItem(LEGACY_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unreadable legacy blob: nothing safe to adopt
  }
  const docState = parsed as { state?: { scanFeed?: Array<{ quantityDelta?: number }> } };
  const feed = docState?.state?.scanFeed;
  if (Array.isArray(feed)) {
    for (const row of feed) {
      if (row && row.quantityDelta === 0) row.quantityDelta = 1;
    }
  }
  storage.setItem(targetKey, JSON.stringify(parsed));
  storage.removeItem(LEGACY_KEY); // consumed: a second sign-in can never inherit it
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/stores/scanPersistNamespace.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Bump persist version to 8 and normalize quantityDelta in migrate**

In `src/stores/scanStore.ts`, in `scanStoreMigrate` (the non-destructive `version >= 5` branch at `:5249-5255`), add a feed normalization so a hydrated legacy per-uid or global blob is also corrected. Replace that return block:

```ts
  const existingProducts = Array.isArray(p.products) ? (p.products as Product[]) : [];
  const existingFeed = Array.isArray(p.scanFeed) ? (p.scanFeed as Array<{ quantityDelta?: number }>) : [];
  // P1-handoff fold-in: legacy v7 feed rows may carry a literal quantityDelta:0 (pre-D1). applyScanEventOnce's
  // `?? 1` does not correct a non-nullish 0, so normalize here where the persisted blob is rebuilt.
  const normalizedFeed = existingFeed.map((row) =>
    row && row.quantityDelta === 0 ? { ...row, quantityDelta: 1 } : row,
  );
  return {
    ...p,
    products: backfillProducts(existingProducts).products,
    scanFeed: normalizedFeed,
    countSnapshots: existingSnapshots,
    settings: { ...DEFAULT_SETTINGS, ...((p.settings as Partial<Settings>) ?? {}) },
  } as never;
```

Then bump the version literal at `:5261`:

```ts
    version: 8,
```

- [ ] **Step 6: Run the store persist tests to confirm no regression**

Run: `npm run test -- src/stores/scanPersistStorage.test.ts src/stores/scanPersist.test.ts`
Expected: PASS. Determinism note: first grep those two named files for the literal `version: 7`; if no assertion on it exists, no fixture change is needed - that is the expected outcome, not a failure. If one asserts it, update that literal to `8`.

- [ ] **Step 7: Commit**

```bash
git add src/stores/scanPersistNamespace.ts src/stores/scanPersistNamespace.test.ts src/stores/scanStore.ts
git commit -m "feat(tenancy): per-uid persist namespace + owner-adopt legacy migration with quantityDelta:0 fold-in (v8)"
```

---

### Task 7: setBusinessContext fully replaces tenant state on switch

**Track:** T3. **Depends on:** Task 6 (same file). **SERIALIZES before Task 8.**

**Files:**
- Create: `src/stores/scanReset.ts` (pure `emptyTenantState()`)
- Modify: `src/stores/scanStore.ts` (`setBusinessContext` at `:1109-1143`)
- Test: `src/stores/scanReset.test.ts`, `src/stores/businessSwitchReset.store.test.ts`

**Interfaces:**
- Produces: `emptyTenantState(): { scanFeed: ScanEvent[]; finalCounts: InventoryCount[]; needsReviewQueue: UnknownCodeReview[]; settings: Settings }` returning empty arrays and `DEFAULT_SETTINGS`. Consumed by Task 8's sign-out reset too.
- Note (scout-verified): `loadBusinessData()` returns only `{ products, aliases, sessions, counts }`, no settings, no review queue, no feed. So switching businessId leaves the PREVIOUS tenant's `settings`/`needsReviewQueue`/`scanFeed` in memory, and `finalCounts` linger when the loader restores no session. This task resets ALL FOUR on every context switch so the per-uid persist key (shared across a user's businesses) can never show one business's rows under another; the loader then restores the new business's session counts. Per-business settings LOADING from Firestore is P3 sync work (not P2); resetting to defaults here is the isolation-correct P2 behavior.

- [ ] **Step 1: Write the failing test (pure reset)**

```ts
// src/stores/scanReset.test.ts
import { describe, it, expect } from "vitest";
import { emptyTenantState } from "./scanReset";
import { DEFAULT_SETTINGS } from "@/stores/scanStore";

describe("emptyTenantState", () => {
  it("returns empty tenant arrays and default settings", () => {
    const s = emptyTenantState();
    expect(s.scanFeed).toEqual([]);
    expect(s.finalCounts).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/stores/scanReset.test.ts`
Expected: FAIL ("Cannot find module './scanReset'").

- [ ] **Step 3: Write the pure reset helper**

```ts
// src/stores/scanReset.ts
import { DEFAULT_SETTINGS } from "@/stores/scanStore";
import type { ScanEvent, InventoryCount, UnknownCodeReview, Settings } from "@/types";

// Tenant-scoped state that must be fully REPLACED (never merged) when the active business/user
// changes: loadBusinessData() does NOT return settings/needsReviewQueue/scanFeed, and finalCounts
// linger when no session restores. Used by setBusinessContext (switch) and resetForSignOut (Task 8).
// Keeps two-users-one-browser AND one-user-two-businesses isolation honest.
export function emptyTenantState(): {
  scanFeed: ScanEvent[];
  finalCounts: InventoryCount[];
  needsReviewQueue: UnknownCodeReview[];
  settings: Settings;
} {
  return { scanFeed: [], finalCounts: [], needsReviewQueue: [], settings: { ...DEFAULT_SETTINGS } };
}
```

(`DEFAULT_SETTINGS` is exported from `scanStore.ts:438`; `ScanEvent`/`InventoryCount`/`UnknownCodeReview`/`Settings` are exported from `src/types.ts` at `:169/:228/:244/:365`.)

- [ ] **Step 4: Write the failing store test (switch fully replaces tenant state)**

```ts
// src/stores/businessSwitchReset.store.test.ts
import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";

describe("setBusinessContext isolation", () => {
  it("clears the previous tenant's needsReviewQueue on a context switch", () => {
    const store = createTestScanStore();
    store.setState({ needsReviewQueue: [{ id: "stale-A" } as never] });
    store.getState().setBusinessContext("business-B", "user-B");
    expect(store.getState().needsReviewQueue).toEqual([]);
    expect(store.getState().businessId).toBe("business-B");
  });

  it("fully REPLACES tenant state when ONE user switches between two businesses", () => {
    const store = createTestScanStore();
    store.setState({
      businessId: "biz-A",
      userId: "user-1",
      scanFeed: [{ id: "feedA" } as never],
      finalCounts: [{ productId: "pA" } as never],
      needsReviewQueue: [{ id: "revA" } as never],
    });
    store.getState().setBusinessContext("biz-B", "user-1");
    const s = store.getState();
    expect(s.scanFeed).toEqual([]); // not merged, not retained
    expect(s.finalCounts).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.businessId).toBe("biz-B");
    expect(s.userId).toBe("user-1");
  });
});
```

(`createTestScanStore` is the real, existing factory exported from `scanStore.ts:5291`. It builds a fresh non-persisted store, pins `now()` to `2026-06-12T10:00:00.000Z`, and defaults `scanContext` to `"any"`.)

- [ ] **Step 5: Run test to verify it fails**

Run: `npm run test -- src/stores/businessSwitchReset.store.test.ts`
Expected: FAIL (needsReviewQueue still contains `stale-A`; scanFeed still contains `feedA`).

- [ ] **Step 6: Edit setBusinessContext to fully replace stale tenant state**

In `src/stores/scanStore.ts`, at the start of `setBusinessContext` (`:1109`), fold the reset into the initial synchronous `set(...)` at `:1111`:

```ts
      setBusinessContext: (businessId, userId) => {
        const needsLoad = cloudBackend && !!deps.loadBusinessData;
        // Isolation: settings/needsReviewQueue/scanFeed are NOT returned by loadBusinessData and
        // finalCounts linger when no session restores, so a context switch must REPLACE all four or
        // the previous tenant's rows bleed through (two users OR one user with two businesses).
        const cleared = emptyTenantState();
        set({
          businessId,
          userId,
          businessContextReady: true,
          businessDataLoaded: !needsLoad,
          lastSyncError: null,
          scanFeed: cleared.scanFeed,
          finalCounts: cleared.finalCounts,
          needsReviewQueue: cleared.needsReviewQueue,
          settings: cleared.settings,
        });
        const loader = deps.loadBusinessData;
        // ... rest unchanged (the async loader IIFE / else branch stay exactly as-is; the loader
        // restores the new business's session finalCounts after this synchronous clear)
```

Add the import near the top of `scanStore.ts` with the other local imports:

```ts
import { emptyTenantState } from "@/stores/scanReset";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- src/stores/scanReset.test.ts src/stores/businessSwitchReset.store.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the existing setBusinessContext-dependent suites (no regression)**

Run: `npm run test -- src/stores/sessionPersistence.store.test.ts src/stores/firebaseBackend.store.test.ts src/stores/cloudDrainRace.store.test.ts`
Expected: PASS (these exercise the loader/queue-drain contract; the loader still reconstructs session + finalCounts AFTER the synchronous clear, so reconstruction assertions hold).

- [ ] **Step 9: Commit**

```bash
git add src/stores/scanReset.ts src/stores/scanReset.test.ts src/stores/businessSwitchReset.store.test.ts src/stores/scanStore.ts
git commit -m "fix(tenancy): context switch fully replaces settings/review/feed/counts"
```

---

### Task 8: Sign-out clears all local tenant state + chokepoint reads 2 and 3 + owner-adopt wiring

**Track:** T3. **Depends on:** Task 6, Task 7 (same file family), Task 2 (S1).

**Files:**
- Modify: `src/stores/scanStore.ts` (new `resetForSignOut`, `rehydrateForUid`, `adoptLegacyLocalData` actions)
- Modify: `src/components/BusinessContextGate.tsx` (chokepoint read 2 of 3 + adopt banner + per-uid rehydrate)
- Modify: `src/components/Nav.tsx` (chokepoint read 3 of 3 at `:50` + sign-out reset)
- Modify: `src/app/(app)/business/page.tsx` (sign-out button at `:59-65` calls the reset; this file does NOT yet import `useScanStore`, add the import)
- Test: `src/stores/signOutReset.store.test.ts`, `src/components/BusinessContextGate.authmode.test.tsx`

**Interfaces:**
- Consumes: `emptyTenantState` (Task 7), `persistKeyForUid`/`hasLegacyBlob`/`migrateLegacyBlobOnce` (Task 6), `clearSelectedBusinessId` (`@/lib/selectedBusiness`, existing dead function gets its first caller), `isLiveAuth` (Task 2).
- Produces:
  - `resetForSignOut(): void` - captures the signed-out uid FIRST, wipes in-memory tenant state to the anon baseline, clears `sis-selected-business-v1`, REMOVES the signed-out user's `sis-scan-${uid}` localStorage key, and re-points the persist middleware at the anon key so the fail-soft coalesced writer cannot re-create the per-uid key on a later tick.
  - `rehydrateForUid(uid: string): void` - re-points persist at `sis-scan-${uid}` and rehydrates. Does NOT migrate the legacy blob (adoption is owner-initiated only).
  - `adoptLegacyLocalData(uid: string): void` - the explicit adopt action: `migrateLegacyBlobOnce` (copy + delete legacy) then `rehydrateForUid`.
- Decision recorded (not silent): Firebase's OWN SDK auth persistence (IndexedDB/localStorage session) is cleared by `fbSignOut` inside `signOut()` (`auth.ts:66-69`); that call, made by both UI sign-out handlers, is the authority for SDK-held auth state. `resetForSignOut` owns only APP state (Zustand persist + `sis-selected-business-v1`).
- Decision recorded: the per-uid key is shared across ONE user's multiple businesses; that is safe because Task 7 makes every `setBusinessContext` switch fully REPLACE tenant state (proven by `businessSwitchReset.store.test.ts`), so no `${uid}:${businessId}` key split is needed in P2.

- [ ] **Step 1: Write the failing store test**

```ts
// src/stores/signOutReset.store.test.ts
import { describe, it, expect } from "vitest";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import { createTestScanStore } from "@/stores/scanStore";

describe("resetForSignOut", () => {
  it("wipes tenant state back to the anon baseline", () => {
    const store = createTestScanStore();
    store.setState({
      businessId: "biz-A",
      userId: "user-A",
      scanFeed: [{ id: "e1" } as never],
      needsReviewQueue: [{ id: "r1" } as never],
      pendingSyncQueue: [{ id: "q1" } as never],
      finalCounts: [{ productId: "p1" } as never],
    });
    store.getState().resetForSignOut();
    const s = store.getState();
    expect(s.businessId).toBe(DEMO_BUSINESS_ID);
    expect(s.userId).toBeNull();
    expect(s.scanFeed).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.pendingSyncQueue).toEqual([]);
    expect(s.finalCounts).toEqual([]);
  });
});
```

(`createTestScanStore` from `scanStore.ts:5291` builds a non-persisted store (`persistName: null`), so the localStorage/persist re-point branches are inert here by design; the localStorage-level proof is Task 16's browser assertion that the per-uid key is GONE.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/stores/signOutReset.store.test.ts`
Expected: FAIL ("resetForSignOut is not a function").

- [ ] **Step 3: Add the three store actions**

In `src/stores/scanStore.ts`, add next to `setBusinessContext` (after `:1143`):

```ts
      resetForSignOut: () => {
        // Capture identity BEFORE the reset wipes it: the per-uid key must be removed and the persist
        // middleware re-pointed to the anon key, or the fail-soft coalesced storage would simply
        // rewrite sis-scan-<uid> on the next tick and the "cleared" state would leak right back.
        const uid = get().userId;
        const cleared = emptyTenantState();
        set({
          businessId: DEMO_BUSINESS_ID,
          userId: null,
          businessContextReady: !cloudBackend,
          businessDataLoaded: !cloudBackend,
          scanFeed: cleared.scanFeed,
          finalCounts: cleared.finalCounts,
          needsReviewQueue: cleared.needsReviewQueue,
          settings: cleared.settings,
          pendingSyncQueue: [],
          syncedScanEventIds: [],
          lastSyncError: null,
        });
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            clearSelectedBusinessId(); // sis-selected-business-v1 is NOT uid-namespaced: explicit clear
            if (uid) window.localStorage.removeItem(persistKeyForUid(uid));
          } catch {
            // ignore storage errors: the in-memory reset above already holds
          }
        }
        // Re-point persist at the anon key. Firebase's own SDK auth persistence is cleared by
        // fbSignOut (auth.ts:66-69) in the UI sign-out handlers - that call is the authority for
        // SDK state; this action owns only app state. Guarded on deps.persistName so the
        // non-persisted test store (createTestScanStore, persistName: null) never touches the
        // module-level app store.
        if (deps.persistName) {
          const persistApi = (useScanStore as unknown as {
            persist?: { setOptions: (o: { name: string }) => void };
          }).persist;
          if (persistApi) persistApi.setOptions({ name: persistKeyForUid(null) });
        }
      },

      rehydrateForUid: (uid: string) => {
        if (typeof window === "undefined" || !window.localStorage) return;
        // Re-point storage at this uid's key and rehydrate from it. NO legacy migration here:
        // adopting the pre-account blob is an explicit owner action (adoptLegacyLocalData), never an
        // automatic side effect of signing in (shared-browser inheritance hazard).
        if (!deps.persistName) return; // non-persisted test store: nothing to re-point
        const persistApi = (useScanStore as unknown as {
          persist?: { setOptions: (o: { name: string }) => void; rehydrate: () => Promise<void> | void };
        }).persist;
        if (persistApi) {
          persistApi.setOptions({ name: persistKeyForUid(uid) });
          void persistApi.rehydrate();
        }
      },

      adoptLegacyLocalData: (uid: string) => {
        if (typeof window === "undefined" || !window.localStorage) return;
        // OWNER-INITIATED adopt: copy sis-scan-v1 into this uid's key (normalizing quantityDelta:0),
        // DELETE the legacy blob, then hydrate from the adopted key.
        migrateLegacyBlobOnce(uid, window.localStorage);
        get().rehydrateForUid(uid);
      },
```

Add the types in the store's state interface (near the `setBusinessContext` type at `:540`):

```ts
  resetForSignOut: () => void;
  rehydrateForUid: (uid: string) => void;
  adoptLegacyLocalData: (uid: string) => void;
```

Add imports at the top of `scanStore.ts`:

```ts
import { clearSelectedBusinessId } from "@/lib/selectedBusiness";
import { persistKeyForUid, migrateLegacyBlobOnce } from "@/stores/scanPersistNamespace";
```

(`DEMO_BUSINESS_ID` and `emptyTenantState` are already imported per Tasks 6/7.)

EXECUTOR NOTE (persist mechanics, verified): the persist `name` at `:5260` is fixed at store creation and cannot read the runtime uid, hence the runtime `persist.setOptions` re-point (`deps.persistName` only drives the initial `_hasHydrated` at `:1105`, it does not rename the key). The store uses `skipHydration: true` (`:5269`), so hydration is always manual; confirm after wiring that `persistApi.rehydrate()` fires `onRehydrateStorage` (`:5279`) and flips `_hasHydrated` via `setHasHydrated(true)` for the newly pointed key, and that the UI paths waiting on `_hasHydrated` behave across a re-point.

- [ ] **Step 4: Migrate BusinessContextGate to the chokepoint + adopt banner**

Replace `src/components/BusinessContextGate.tsx` in full (chokepoint read 2 of 3: the `openAccess` env read at `:20` is deleted; `cloud` becomes `isLiveAuth() && isFirebaseBackend()`):

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useScanStore } from "@/stores/scanStore";
import { getSession, listMemberships } from "@/lib/auth";
import { getSelectedBusinessId, isFirebaseBackend } from "@/lib/selectedBusiness";
import { isLiveAuth } from "@/services/auth/authMode";
import { hasLegacyBlob, persistKeyForUid } from "@/stores/scanPersistNamespace";

// Wires the REAL signed-in business context into the scan/count workflow (live mode + Firebase backend).
// On mount it resolves the authenticated user + the selected business and verifies a real membership.
// If this browser still holds the pre-account legacy blob (sis-scan-v1) and the user has no per-uid
// key yet, it STOPS and asks the owner whether to adopt that data - adoption is an explicit choice,
// never an automatic first-sign-in inheritance (shared-browser hazard). Then it re-points persist to
// the per-uid key and calls setBusinessContext exactly once. The mock path renders children directly.
export function BusinessContextGate({ children }: { children: React.ReactNode }) {
  const cloud = isLiveAuth() && isFirebaseBackend();
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  const businessDataLoaded = useScanStore((s) => s.businessDataLoaded);
  const setBusinessContext = useScanStore((s) => s.setBusinessContext);
  const [status, setStatus] = useState<"resolving" | "no-user" | "no-business" | "adopt-choice" | "ready">("resolving");
  const [pendingCtx, setPendingCtx] = useState<{ businessId: string; uid: string } | null>(null);

  useEffect(() => {
    if (!cloud) return; // mock/local path: nothing to wire (context + data already "ready")
    let active = true;
    void (async () => {
      const user = await getSession();
      if (!active) return;
      if (!user) { setStatus("no-user"); return; }

      const selected = getSelectedBusinessId();
      const memberships = await listMemberships();
      if (!active) return;
      const membership = selected ? memberships.find((m) => m.businessId === selected) : undefined;
      if (!membership) { setStatus("no-business"); return; }

      // Legacy pre-account data on this browser + no per-uid key yet: the OWNER decides.
      const legacy = typeof window !== "undefined" && hasLegacyBlob(window.localStorage);
      const alreadyOwn =
        typeof window !== "undefined" && window.localStorage.getItem(persistKeyForUid(user.uid)) !== null;
      if (legacy && !alreadyOwn) {
        setPendingCtx({ businessId: membership.businessId, uid: user.uid });
        setStatus("adopt-choice");
        return;
      }

      useScanStore.getState().rehydrateForUid(user.uid);
      setBusinessContext(membership.businessId, user.uid);
      setStatus("ready");
    })();
    return () => { active = false; };
  }, [cloud, setBusinessContext]);

  if (!cloud) return <>{children}</>;

  if (status === "adopt-choice" && pendingCtx) {
    return (
      <div data-testid="adopt-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        This device has local scan data saved from before sign-in. Adopt it into your account, or leave it and start fresh.
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-testid="adopt-data"
            onClick={() => {
              useScanStore.getState().adoptLegacyLocalData(pendingCtx.uid);
              setBusinessContext(pendingCtx.businessId, pendingCtx.uid);
              setStatus("ready");
            }}
            className="inline-flex min-h-[40px] items-center rounded-lg bg-amber-600 px-3 font-medium text-white hover:bg-amber-700"
          >
            Adopt it into my account
          </button>
          <button
            type="button"
            data-testid="skip-adopt"
            onClick={() => {
              useScanStore.getState().rehydrateForUid(pendingCtx.uid);
              setBusinessContext(pendingCtx.businessId, pendingCtx.uid);
              setStatus("ready");
            }}
            className="inline-flex min-h-[40px] items-center rounded-lg border border-amber-400 px-3 font-medium hover:bg-amber-100"
          >
            Start fresh (leave it)
          </button>
        </div>
      </div>
    );
  }

  // Needs a signed-in user or a selected business: a clear, actionable message (no fake context).
  if (status === "no-user" || status === "no-business") {
    return (
      <div data-testid="business-context-banner" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {status === "no-user" ? (
          <>You are not signed in. <Link href="/login" className="font-medium underline">Sign in</Link> to sync to the cloud.</>
        ) : (
          <>Select or create a business before Firebase sync can run.{" "}
            <Link href="/business" className="font-medium underline" data-testid="go-to-business">Choose a business</Link>.</>
        )}
      </div>
    );
  }

  // Context set but the business's data is still loading: show a status, do not let a scan run yet.
  if (!businessContextReady || !businessDataLoaded) {
    return (
      <div data-testid="business-loading" className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
        Loading business data...
      </div>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 5: Write the BusinessContextGate chokepoint test (AUTH_MODE=live must engage the gate)**

```tsx
// src/components/BusinessContextGate.authmode.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const isLiveAuth = vi.fn();
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => isLiveAuth() }));
vi.mock("@/lib/selectedBusiness", () => ({
  getSelectedBusinessId: () => null,
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  listMemberships: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasLegacyBlob: () => false,
  persistKeyForUid: (uid: string | null) => (uid ? `sis-scan-${uid}` : "sis-scan-v1"),
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ businessContextReady: false, businessDataLoaded: false, setBusinessContext: vi.fn() }),
    { getState: () => ({ rehydrateForUid: vi.fn(), adoptLegacyLocalData: vi.fn() }) },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

describe("BusinessContextGate + AUTH_MODE", () => {
  it("mock mode: cloud=false, children render directly", () => {
    isLiveAuth.mockReturnValue(false);
    render(<BusinessContextGate><div data-testid="child">hi</div></BusinessContextGate>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
  it("live mode + Firebase backend: cloud=true, the gate engages (banner, children withheld)", async () => {
    isLiveAuth.mockReturnValue(true);
    render(<BusinessContextGate><div data-testid="child">hi</div></BusinessContextGate>);
    expect(screen.queryByTestId("child")).toBeNull();
    expect(await screen.findByTestId("business-context-banner")).toBeInTheDocument();
  });
});
```

This is the regression lock for the half-migrated-chokepoint failure mode: `AUTH_MODE=live` MUST make this gate compute `cloud=true`, or live users would keep the anon persist key.

- [ ] **Step 6: Wire sign-out in the two UI call sites (+ chokepoint read 3 of 3)**

In `src/components/Nav.tsx`: `useScanStore` is ALREADY imported (`Nav.tsx:5`). Replace the visibility conditional at `:50` (the third and last duplicated env read) and the handler at `:53-57`, preserving the existing confirm copy exactly:

```tsx
        {isLiveAuth() && (
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm("Log out now? Your counts are saved - you can sign back in any time to keep going.")) return;
              useScanStore.getState().resetForSignOut();
              await signOut();
              router.replace("/login");
            }}
            className="ml-auto inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Log out
          </button>
        )}
```

Add the import to `Nav.tsx`:

```tsx
import { isLiveAuth } from "@/services/auth/authMode";
```

Note: this button renders ONLY in live mode, so mock-mode Playwright cannot click it; the sign-out reset is proven via `window.__scanStore` in Task 16, not a mock-mode click.

In `src/app/(app)/business/page.tsx` (sign-out button at `:59-65`, currently `onClick={async () => { await signOut(); router.replace("/login"); }}`), reset before sign-out:

```tsx
        <button
          onClick={async () => { useScanStore.getState().resetForSignOut(); await signOut(); router.replace("/login"); }}
          className="text-sm text-zinc-500 hover:underline"
          data-testid="sign-out"
        >
          Sign out
        </button>
```

This file does NOT import `useScanStore` today; add it:

```tsx
import { useScanStore } from "@/stores/scanStore";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- src/stores/signOutReset.store.test.ts src/components/BusinessContextGate.authmode.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the whole store suite (no regression)**

Run: `npm run test -- src/stores`
Expected: PASS (all existing store suites green).

- [ ] **Step 9: Commit**

```bash
git add src/stores/scanStore.ts src/components/BusinessContextGate.tsx src/components/Nav.tsx src/app/\(app\)/business/page.tsx src/stores/signOutReset.store.test.ts src/components/BusinessContextGate.authmode.test.tsx
git commit -m "feat(tenancy): sign-out clears + removes per-uid key; chokepoint reads 2-3; owner-adopt banner"
```

---

### Task 9: Server-side confidenceThreshold clamp (pure policy)

**Track:** T2. **Depends on:** none.

**Files:**
- Create: `src/services/security/decodePolicy.ts`
- Test: `src/services/security/decodePolicy.test.ts`

**Interfaces:**
- Produces: `clampConfidenceThreshold(value: unknown): number` returning a number in `[MIN_THRESHOLD, MAX_THRESHOLD]` with a `DEFAULT_THRESHOLD` (0.8) fallback for non-numbers/NaN. Consumed by Task 10 (route).

- [ ] **Step 1: Write the failing test**

```ts
// src/services/security/decodePolicy.test.ts
import { describe, it, expect } from "vitest";
import { clampConfidenceThreshold, DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD } from "./decodePolicy";

describe("clampConfidenceThreshold", () => {
  it("defaults when the value is missing or not a number", () => {
    expect(clampConfidenceThreshold(undefined)).toBe(DEFAULT_THRESHOLD);
    expect(clampConfidenceThreshold("0.9" as unknown)).toBe(DEFAULT_THRESHOLD);
    expect(clampConfidenceThreshold(NaN)).toBe(DEFAULT_THRESHOLD);
  });
  it("clamps a too-low value up to the floor (blocks force-verify)", () => {
    expect(clampConfidenceThreshold(0)).toBe(MIN_THRESHOLD);
    expect(clampConfidenceThreshold(-5)).toBe(MIN_THRESHOLD);
  });
  it("clamps a too-high value down to the ceiling (blocks force-review)", () => {
    expect(clampConfidenceThreshold(2)).toBe(MAX_THRESHOLD);
  });
  it("passes a valid in-range value through", () => {
    expect(clampConfidenceThreshold(0.85)).toBe(0.85);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/services/security/decodePolicy.test.ts`
Expected: FAIL ("Cannot find module './decodePolicy'").

- [ ] **Step 3: Write the policy**

```ts
// src/services/security/decodePolicy.ts
// Server-side decode policy clamps. The client sends a confidenceThreshold as a UX preference, but a
// hand-crafted request must never be able to force every decode to "verified" (threshold 0) or to
// "needs_review" (threshold >1). Mirrors the clampDecodeBudgetMs pattern already used for budgetMs.

export const DEFAULT_THRESHOLD = 0.8;
export const MIN_THRESHOLD = 0.6; // never auto-verify below strong app-verified evidence policy
export const MAX_THRESHOLD = 0.95; // never make verification effectively impossible from the client

export function clampConfidenceThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(Math.max(value, MIN_THRESHOLD), MAX_THRESHOLD);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/services/security/decodePolicy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/security/decodePolicy.ts src/services/security/decodePolicy.test.ts
git commit -m "feat(server-trust): server-side confidenceThreshold clamp policy (D4)"
```

---

### Task 10: ai-lookup route - full D4 surface + live-mode auth + per-account quota on the paid signal

**Track:** T2. **Depends on:** Task 9, Task 11, Task 2 (S1).

**Files:**
- Modify: `src/app/api/ai-lookup/route.ts` (`:206` codeType, `:245` threshold, `:211-218` + `:247` + `:260` scanContext/autoCount, `:229-242` cap gate, top imports)
- Modify: `src/server/decode/pipeline.ts` (MINIMAL: `paidComputeCharged` boolean; computed variant of `DecodePipelineResult` at `:407-410`; flag set after the single `chargeDailySlot` at `:1229`)
- Test: `src/app/api/ai-lookup/route.d4.test.ts`

**Interfaces:**
- Consumes: `clampConfidenceThreshold` (Task 9); `readDailyUsedForAccount`/`chargeDailySlotForAccount` (Task 11); `isLiveAuth` (Task 2); `getAdminAuth`/`getAdminDb`, `COLLECTIONS`/`memberDocId` (existing, per the `resolve-scan/route.ts` pattern).
- Behavior contract: in `mock` mode the route keeps today's behavior (no auth, global cap) EXCEPT `codeType` is always server-recomputed and `confidenceThreshold` always clamped (pure hardening, no contract change). In `live` mode: require `idToken` + `businessId`, verify the token, confirm membership BEFORE any quota read/charge, make `scanContext` and `autoCountNonPublicWithEvidence` server-authoritative (the client's values are ignored), and layer the per-account daily counter. The D4 stakes (adversary-verified): `scanContext === "tire"` unlocks three extra auto-verify paths in `decideDecode` (`decode.ts:285/304/323`) and `allowNonPublicAutoCount` unlocks `nonPublicTrustedVerified` (`decode.ts:269`), the ladder-1225 hallucinated-auto-count class.
- Charge contract (L12, adversary-verified): the pipeline's free rung-0 corpus/retail/learned hits ALL return `{ kind: "computed", cached: false }` (`pipeline.ts:542/572/586`), so `!cached` is NOT a paid signal. The per-account charge gates on `paidComputeCharged`, a boolean set at the pipeline's ONE existing global `chargeDailySlot` site (`:1229`), so both counters always move on the identical genuine-paid-compute event.
- The existing `route.test.ts` regression suite (mock/e2e) MUST stay green.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/ai-lookup/route.d4.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// MANDATORY pipeline mock: the route must reach its auth/policy gates deterministically with zero
// pipeline/provider work, and e2eMode must report false or the live-mode gates are skipped entirely.
const runDecodePipeline = vi.fn();
vi.mock("@/server/decode/pipeline", () => ({
  runDecodePipeline: (...a: unknown[]) => runDecodePipeline(...a),
  e2eMode: () => false,
}));
const readDailyUsedForAccount = vi.fn();
const chargeDailySlotForAccount = vi.fn();
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return {
    ...orig,
    killSwitchOn: () => false,
    checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
    readDailyUsedForAccount: (...a: unknown[]) => readDailyUsedForAccount(...a),
    chargeDailySlotForAccount: (...a: unknown[]) => chargeDailySlotForAccount(...a),
  };
});
const memberGet = vi.fn();
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1", email: "a@b.co" }) }),
  getAdminDb: () => ({ doc: () => ({ get: memberGet }) }),
}));

const ORIG = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = "live";
  delete process.env.IS_E2E;
  delete process.env.AI_LIVE_SCAN_CONTEXT;
  delete process.env.AI_ALLOW_NONPUBLIC_AUTOCOUNT;
  runDecodePipeline.mockReset().mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
  memberGet.mockReset().mockResolvedValue({ exists: true });
  readDailyUsedForAccount.mockReset().mockResolvedValue(0);
  chargeDailySlotForAccount.mockReset().mockResolvedValue(1);
});
afterEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
  process.env.IS_E2E = ORIG.IS_E2E;
});

function decodeReq(extra: Record<string, unknown> = {}) {
  return new Request("http://x/api/ai-lookup", {
    method: "POST",
    body: JSON.stringify({ mode: "decode", cleanCode: "TX100-PN", businessId: "b1", idToken: "t", ...extra }),
  });
}

describe("ai-lookup D4 live-mode trust", () => {
  it("rejects a decode request with no idToken (401), before any pipeline work", async () => {
    const { POST } = await import("./route");
    const res = await POST(new Request("http://x/api/ai-lookup", {
      method: "POST",
      body: JSON.stringify({ mode: "decode", cleanCode: "0123456789012", businessId: "b1" }),
    }));
    expect(res.status).toBe(401);
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("membership gate runs BEFORE any quota read/charge (403, zero per-account key touches)", async () => {
    memberGet.mockResolvedValue({ exists: false }); // authed member of A, sent businessId "B"
    const { POST } = await import("./route");
    const res = await POST(decodeReq());
    expect(res.status).toBe(403);
    expect(readDailyUsedForAccount).not.toHaveBeenCalled();
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled();
    expect(runDecodePipeline).not.toHaveBeenCalled();
  });

  it("hostile scanContext 'tire' + autoCount flag never reach the pipeline in live mode (server policy wins)", async () => {
    const { POST } = await import("./route");
    await POST(decodeReq({ scanContext: "tire", autoCountNonPublicWithEvidence: true, codeType: "upc" }));
    expect(runDecodePipeline).toHaveBeenCalledOnce();
    const arg = runDecodePipeline.mock.calls[0][0] as {
      scanContext?: string; allowNonPublicAutoCount: boolean; codeType: string;
    };
    expect(arg.scanContext).toBe("any"); // live policy default: no tire auto-verify paths unlockable by a client
    expect(arg.allowNonPublicAutoCount).toBe(false); // live policy default: env AI_ALLOW_NONPUBLIC_AUTOCOUNT unset -> off
    expect(arg.codeType).not.toBe("upc"); // "TX100-PN" is not a UPC; server recompute wins over the client claim
  });

  it("per-account charge fires ONLY on paidComputeCharged (free rung-0 hit never charges the account)", async () => {
    const { POST } = await import("./route");
    runDecodePipeline.mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: false });
    await POST(decodeReq());
    expect(chargeDailySlotForAccount).not.toHaveBeenCalled(); // computed but FREE (corpus/retail/learned)

    runDecodePipeline.mockResolvedValue({ kind: "computed", payload: { debug: {} }, cached: false, paidComputeCharged: true });
    await POST(decodeReq());
    expect(chargeDailySlotForAccount).toHaveBeenCalledOnce(); // genuine paid compute: exactly one account charge
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/app/api/ai-lookup/route.d4.test.ts`
Expected: FAIL (route has no auth: the first test gets a decode response, not 401; `paidComputeCharged` does not exist yet).

- [ ] **Step 3: Add imports + Node runtime to route.ts**

At the top of `src/app/api/ai-lookup/route.ts` (with the existing imports around `:1-18`):

```ts
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/services/auth/authMode";
import { clampConfidenceThreshold } from "@/services/security/decodePolicy";
import { readDailyUsedForAccount, chargeDailySlotForAccount } from "@/services/security/aiSpendGuard";
```

Add, next to the existing `export const dynamic = "force-dynamic";` at `:38` (verified absent today, this step is unconditional):

```ts
export const runtime = "nodejs"; // Admin SDK requires the Node runtime (same as resolve-scan/route.ts:25)
```

- [ ] **Step 4: Add the live-mode auth block + always-recompute codeType**

Immediately after the JSON body parse (after `:200`), before the sanitize block, add the live-mode gate. Extend the body type to include `idToken?: string; businessId?: string;`:

```ts
  // LIVE-MODE AUTH (D4). In mock mode this whole block is skipped, so the open-demo behavior and every
  // existing test are unchanged. In live mode the caller must present a verified Firebase ID token and a
  // businessId they are a member of - identical pattern to resolve-scan/route.ts. ORDERING CONTRACT
  // (locked by route.d4.test.ts): this gate completes BEFORE any quota read or charge, global or
  // per-account - a 401/403 request must never touch a counter key.
  let authedBusinessId: string | null = null;
  if (isLiveAuth() && !e2eMode()) {
    const idToken = (body as { idToken?: string }).idToken ?? "";
    const bizId = (body as { businessId?: string }).businessId ?? "";
    if (!idToken.trim()) {
      return Response.json({ error: "Sign in required.", reasonCode: "unauthenticated" }, { status: 401 });
    }
    if (!bizId.trim()) {
      return Response.json({ error: "Missing businessId.", reasonCode: "no_business" }, { status: 400 });
    }
    let uid = "";
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(msg)) {
        return Response.json({ error: "Server auth is not configured.", reasonCode: "auth_unavailable" }, { status: 503 });
      }
      return Response.json({ error: "Invalid or expired sign-in.", reasonCode: "bad_token" }, { status: 401 });
    }
    const member = await getAdminDb().doc(`${COLLECTIONS.businessMembers}/${memberDocId(bizId, uid)}`).get();
    if (!member.exists) {
      return Response.json({ error: "Not a member of this business.", reasonCode: "not_member" }, { status: 403 });
    }
    authedBusinessId = bizId;
  }
```

Change the `codeType` line (`:206`) to ALWAYS recompute server-side (drop the client-first `||`):

```ts
  // D4: never trust the client's codeType. Always recompute from the sanitized code server-side.
  const codeType = detectCodeType(code);
```

- [ ] **Step 5: Make scanContext + autoCountNonPublicWithEvidence server-authoritative; clamp the threshold**

Directly below the codeType line, add the policy resolution (this replaces every later read of `body.scanContext` and `body.autoCountNonPublicWithEvidence`):

```ts
  // D4 (full surface): scanContext and autoCountNonPublicWithEvidence are DECISION inputs, not hints.
  // scanContext === "tire" unlocks three extra auto-verify paths in decideDecode (decode.ts:285/304/323)
  // and allowNonPublicAutoCount unlocks nonPublicTrustedVerified (decode.ts:269) - the ladder-1225
  // hallucinated-auto-count class. LIVE mode: server policy decides, the client's values are ignored
  // (AI_LIVE_SCAN_CONTEXT=tire opts a deployment into the tire context; default "any" unlocks nothing;
  // AI_ALLOW_NONPUBLIC_AUTOCOUNT=1 opts into non-public auto-count; default off). MOCK mode: the client
  // hint is honored exactly as today (validated to the known set), so the demo substrate is unchanged.
  const SCAN_CONTEXTS = new Set(["any", "tire"]);
  const clientScanContext =
    typeof body.scanContext === "string" && SCAN_CONTEXTS.has(body.scanContext)
      ? (body.scanContext as "any" | "tire")
      : undefined;
  const scanContext: "any" | "tire" | undefined =
    isLiveAuth() && !e2eMode()
      ? (process.env.AI_LIVE_SCAN_CONTEXT === "tire" ? "tire" : "any")
      : clientScanContext;
  const allowNonPublicAutoCount =
    isLiveAuth() && !e2eMode()
      ? process.env.AI_ALLOW_NONPUBLIC_AUTOCOUNT === "1"
      : body.autoCountNonPublicWithEvidence !== false;
```

Then use these resolved values everywhere the old body reads were: in the `req` object at `:211-218` (`scanContext: body.scanContext` becomes `scanContext`), delete the old `allowNonPublicAutoCount` line at `:247`, and in the `runDecodePipeline` call at `:252-265` (`scanContext: body.scanContext` becomes `scanContext`; `allowNonPublicAutoCount` now refers to the policy-resolved const). Change the threshold line at `:245`:

```ts
    const threshold = clampConfidenceThreshold(body.confidenceThreshold);
```

- [ ] **Step 6: Thread the paid-compute signal + layer the per-account quota**

**(a) pipeline.ts, minimal two-part change.** In `src/server/decode/pipeline.ts`:

1. Extend the computed variant of `DecodePipelineResult` (`:407-410`) with a REQUIRED boolean so tsc flags every computed return site:

```ts
export type DecodePipelineResult =
  | { kind: "persisted"; body: Record<string, unknown> }
  | { kind: "cap_blocked"; message: string; floor?: import("@/services/catalog/prefixFloor").PrefixFloorResult }
  | { kind: "computed"; payload: DecodePayload; cached: boolean; paidComputeCharged: boolean };
```

2. In `runDecodePipeline`, declare `let paidComputeCharged = false;` next to `decodeStartedAt` (`:425` region); set `paidComputeCharged = true;` on the line immediately after the single existing `await chargeDailySlot(ladderStore, { limit });` (`:1229`, the ONLY global charge site in this file - verified). NOTE: that charge site sits INSIDE the nested `chargePaidSlot` arrow function (declared `:1223`); the outer `let` is captured by closure, so setting it there is correct and intended - do not "fix" this by moving the flag outside the closure. Add `paidComputeCharged` to EVERY `{ kind: "computed", ... }` return object (the free rung-0 returns at `:542/:572/:586` and every later computed return; the compiler enumerates them once the type is required). No rung, cache, cap, or breaker logic changes.

**(b) route.ts, legacy `lookup` mode.** In the existing gate block (`:231-242`), the global charge at the gate IS that mode's paid charge (the single provider call follows immediately), so the account counter rides the same spot:

```ts
  if (!e2eMode() && !isDecodeMode) {
    const ladderStore = await ladderStorage();
    const used = await readDailyUsed(ladderStore);
    const limit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500);
    if (used >= limit) {
      return Response.json(
        { error: `Daily AI lookup cap reached (${used}/${limit}). No AI call made.`, reasonCode: "daily_cap" },
        { status: 429 }
      );
    }
    // Per-account cap layered on the global cap: same gate, same single charge point (L12).
    if (authedBusinessId) {
      const acctUsed = await readDailyUsedForAccount(ladderStore, authedBusinessId);
      const acctLimit = intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, limit);
      if (acctUsed >= acctLimit) {
        return Response.json(
          { error: `Your daily AI lookup cap is reached (${acctUsed}/${acctLimit}).`, reasonCode: "account_daily_cap" },
          { status: 429 }
        );
      }
    }
    await chargeDailySlot(ladderStore, { limit });
    if (authedBusinessId) await chargeDailySlotForAccount(ladderStore, authedBusinessId);
  }
```

**(c) route.ts, decode mode.** Add a READ-ONLY per-account gate before the pipeline call (inside the `isDecodeMode` branch, after the threshold line):

```ts
    // Per-account decode cap: read-only gate (the pipeline owns the single global charge). The
    // account counter is charged below ONLY when the pipeline reports a genuine paid compute.
    if (authedBusinessId && !e2eMode()) {
      const ladderStore = await ladderStorage();
      const acctUsed = await readDailyUsedForAccount(ladderStore, authedBusinessId);
      const acctLimit = intEnv(process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT, intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 500));
      if (acctUsed >= acctLimit) {
        return Response.json(
          { error: `Your daily AI lookup cap is reached (${acctUsed}/${acctLimit}).`, reasonCode: "account_daily_cap" },
          { status: 429 }
        );
      }
    }
```

And at the computed return (`:276-277` region), gate the account charge on the paid signal - NEVER on `cached`:

```ts
    // computed: echo the L1/L2 `cached` flag into debug exactly as before. The per-account charge
    // rides paidComputeCharged - the pipeline's own single global-charge signal - so a FREE rung-0
    // corpus/retail/learned hit (also kind:"computed", cached:false) never bills the account (L12).
    if (authedBusinessId && outcome.paidComputeCharged && !e2eMode()) {
      await chargeDailySlotForAccount(await ladderStorage(), authedBusinessId);
    }
    return Response.json({ ...outcome.payload, debug: { ...outcome.payload.debug, cached: outcome.cached } });
```

- [ ] **Step 7: Run the new tests + the existing route regression suite + typecheck**

Run: `npm run test -- src/app/api/ai-lookup/route.d4.test.ts src/app/api/ai-lookup/route.test.ts`
Expected: PASS. The existing `route.test.ts` runs in mock/e2e (auth block skipped; codeType recompute and threshold clamp are pure hardening; if any existing test SENT a bogus `codeType` or out-of-range threshold expecting it honored, update that assertion to the recomputed/clamped value and note it in the commit body).

Run: `npx tsc --noEmit`
Expected: PASS (confirms every computed return site in pipeline.ts carries `paidComputeCharged`).

- [ ] **Step 8: Commit**

```bash
git add src/app/api/ai-lookup/route.ts src/server/decode/pipeline.ts src/app/api/ai-lookup/route.d4.test.ts
git commit -m "fix(server-trust): ai-lookup live auth, full D4 clamp surface, per-account cap on the paid signal"
```

---

### Task 11: Per-account quota primitives in aiSpendGuard

**Track:** T2. **Depends on:** none.

**Files:**
- Modify: `src/services/security/aiSpendGuard.ts` (add three exports near the `DAILY_KEY_PREFIX`/`readDailyUsed`/`chargeDailySlot` region, `:79-112`)
- Test: `src/services/security/aiSpendGuard.account.test.ts`

**Interfaces:**
- Produces: `perAccountDailyKey(businessId: string, dateKey?: string): string`; `readDailyUsedForAccount(storage: DailyCapStorage, businessId: string, dateKey?: string): Promise<number>`; `chargeDailySlotForAccount(storage: DailyCapStorage, businessId: string, dateKey?: string): Promise<number>`. Consumed by Task 10.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/security/aiSpendGuard.account.test.ts
import { describe, it, expect } from "vitest";
import { perAccountDailyKey, readDailyUsedForAccount, chargeDailySlotForAccount } from "./aiSpendGuard";

function memStore() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async increment(k: string) { const n = (Number(m.get(k) ?? 0) || 0) + 1; m.set(k, String(n)); return n; },
  };
}

describe("per-account daily quota", () => {
  it("keys by businessId and date, distinct from the global key", () => {
    expect(perAccountDailyKey("b1", "2026-06-12")).toBe("ai_daily_cap:b1:2026-06-12");
    expect(perAccountDailyKey("b1", "2026-06-12")).not.toBe("ai_daily_cap:2026-06-12");
  });
  it("reads zero before any charge and counts charges per account", async () => {
    const s = memStore();
    expect(await readDailyUsedForAccount(s, "b1", "d")).toBe(0);
    await chargeDailySlotForAccount(s, "b1", "d");
    await chargeDailySlotForAccount(s, "b1", "d");
    expect(await readDailyUsedForAccount(s, "b1", "d")).toBe(2);
    expect(await readDailyUsedForAccount(s, "b2", "d")).toBe(0); // isolated per account
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/services/security/aiSpendGuard.account.test.ts`
Expected: FAIL ("perAccountDailyKey is not exported").

- [ ] **Step 3: Add the primitives**

In `src/services/security/aiSpendGuard.ts`, after `chargeDailySlot` (after `:112`):

```ts
/**
 * Per-account daily-cap key. Distinct namespace from the global `ai_daily_cap:<date>` so a per-account
 * layer never collides with (or double-counts against) the global counter. Charged only alongside the
 * global charge on the SAME genuine-paid-compute signal, exactly once per request (L12).
 */
export function perAccountDailyKey(businessId: string, dateKey: string = todayKey()): string {
  return `${DAILY_KEY_PREFIX}${businessId}:${dateKey}`;
}

/** Read-only peek at a single account's daily usage. Never inflates the counter. */
export async function readDailyUsedForAccount(
  storage: DailyCapStorage,
  businessId: string,
  dateKey: string = todayKey(),
): Promise<number> {
  const raw = await storage.get(perAccountDailyKey(businessId, dateKey));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Atomically charge one account daily slot. Same one-charge-per-request discipline as chargeDailySlot. */
export async function chargeDailySlotForAccount(
  storage: DailyCapStorage,
  businessId: string,
  dateKey: string = todayKey(),
): Promise<number> {
  return storage.increment(perAccountDailyKey(businessId, dateKey));
}
```

(`todayKey` and `DAILY_KEY_PREFIX` are already defined in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/services/security/aiSpendGuard.account.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/security/aiSpendGuard.ts src/services/security/aiSpendGuard.account.test.ts
git commit -m "feat(server-trust): per-account daily quota primitives (no businessId double-charge)"
```

---

### Task 12: Extend the passing catalogEntries deny rules test

**Track:** T2. **Depends on:** none. Emulator-gated.

**Files:**
- Modify: `src/services/db/firebase/tenantIsolation.rules.test.ts` (seed block at `:37-54`; add cases after the existing catalogEntries test at `:112-115`)

**Interfaces:**
- Asserts the master-append surface stays read-public / write-denied for clients (the P2 invariant: tenant edits NEVER write master; the server Admin-SDK writer is out of P2 scope and does not exist yet).
- File facts (verified): the suite declares `let env: RulesTestEnvironment` (`:22`) with `aDb()`/`bDb()` authed-context helpers (`:56-57`); seeding happens rules-disabled in `beforeEach` (`:37-54`); `catalogEntries` doc id `"c1"` is already seeded (`:52`); `retailCatalogEntries` is NOT seeded today; `updateDoc`/`deleteDoc` are ALREADY imported at `:3`. Note: plain `npm run test` SKIPS this whole file by design (`describe.skipIf(!ready)` keyed off `FIRESTORE_EMULATOR_HOST`, `:11-12,21`); it is only actually proven under `npm run test:firebase`.

- [ ] **Step 1: Seed retailCatalogEntries**

Add one line inside the `beforeEach` seed block (with the other `setDoc` calls, after `:52`):

```ts
      await setDoc(doc(db, "retailCatalogEntries", "r1"), { normalizedBarcode: "333" });
```

- [ ] **Step 2: Add the extended deny cases**

After the existing catalogEntries test (`:112-115`), using the file's own `aDb()`/`bDb()` helpers and the seeded ids `c1`/`r1`:

```ts
  it("retailCatalogEntries: signed-in read allowed; create/update/delete all denied client-side", async () => {
    await assertSucceeds(getDoc(doc(bDb(), "retailCatalogEntries", "r1")));
    await assertFails(setDoc(doc(bDb(), "retailCatalogEntries", "r2"), { normalizedBarcode: "222" }));
    await assertFails(updateDoc(doc(bDb(), "retailCatalogEntries", "r1"), { productName: "tampered" }));
    await assertFails(deleteDoc(doc(bDb(), "retailCatalogEntries", "r1")));
  });

  it("catalogEntries: even a business OWNER cannot write/update/delete the master append surface", async () => {
    // userA owns BIZ_A - tenant authority must confer ZERO master-store authority (invariant #4).
    await assertFails(setDoc(doc(aDb(), "catalogEntries", "c2"), { provenanceTier: "ladder_verified_strong" }));
    await assertFails(updateDoc(doc(aDb(), "catalogEntries", "c1"), { provenanceTier: "corpus_verified" }));
    await assertFails(deleteDoc(doc(aDb(), "catalogEntries", "c1")));
  });
```

- [ ] **Step 3: Run the emulator rules suite**

Run: `npm run test:firebase`
Expected: PASS (all rules files; the two new cases green). $0, local emulator. (Plain `npm run test` skipping this file is expected, not a failure.)

- [ ] **Step 4: Commit**

```bash
git add src/services/db/firebase/tenantIsolation.rules.test.ts
git commit -m "test(tenancy): extend master-append deny rules (catalogEntries + retailCatalogEntries)"
```

---

### Task 13: Resolver tier interface (tenant-truth vs master-truth slot)

**Track:** T4. **Depends on:** none. Independent of Tasks 14/15.

**Files:**
- Modify: `src/services/aliasMatcher.ts` (add a new exported function; leave `resolveScanToProduct` at `:146-159` unchanged)
- Test: `src/services/resolverTier.test.ts`

**Interfaces:**
- Produces: `type TierInput = { products: Product[]; aliases: Alias[]; masterCandidates?: MasterCandidate[] }`; `type MasterCandidate = { productId: string; matchedOn: string; provenanceTier: ProvenanceTier }`; `resolveScanToProductTiered(cleaned: CleanedCode, input: TierInput, businessId: string): ScanResolution`. Behavior in P2: returns exactly what `resolveScanToProduct` returns today (tenant tiers only). `masterCandidates` is accepted and CARRIED but NOT yet compared across tiers - P5 owns the cross-tier conflict logic (D5). This task only defines the interface so P5 has a slot; it must NOT change any current resolution outcome.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/resolverTier.test.ts
import { describe, it, expect } from "vitest";
import { resolveScanToProductTiered, resolveScanToProduct } from "./aliasMatcher";
import { cleanScanCode } from "@/services/scanCleaner";
import type { Product, Alias } from "@/types";

const BID = "b1";
const products: Product[] = [];
const aliases: Alias[] = [];

describe("resolveScanToProductTiered", () => {
  it("matches today's resolveScanToProduct output when no master candidates are supplied", () => {
    const cleaned = cleanScanCode("0123456789012");
    const tiered = resolveScanToProductTiered(cleaned, { products, aliases }, BID);
    const legacy = resolveScanToProduct(cleaned, products, aliases, BID);
    expect(tiered).toEqual(legacy);
  });

  it("accepts master candidates without changing the outcome in P2 (interface only)", () => {
    const cleaned = cleanScanCode("0123456789012");
    const tiered = resolveScanToProductTiered(
      cleaned,
      { products, aliases, masterCandidates: [{ productId: "m1", matchedOn: "0123456789012", provenanceTier: "corpus_verified" }] },
      BID,
    );
    expect(tiered.matchType).toBe("unknown"); // no tenant match; master slot carried, not yet compared (P5)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/services/resolverTier.test.ts`
Expected: FAIL ("resolveScanToProductTiered is not exported").

- [ ] **Step 3: Add the tiered interface (no behavior change)**

In `src/services/aliasMatcher.ts`, add after `resolveScanToProduct` (`:159`). Import `ProvenanceTier` from `@/types` at the top of the file:

```ts
// Resolver tier interface (P2). Presents tenant truth (the account's own products/aliases) and, in a
// slot, master truth (corpus/catalogEntries candidates carrying a provenanceTier). In P2 the master slot
// is CARRIED but not compared - it exists so P5 can add cross-tier conflict detection (D5) without
// re-plumbing callers. P2 outcome is identical to resolveScanToProduct (tenant tiers only, short-circuit
// preserved). Do NOT add conflict logic here; that is P5.
export type MasterCandidate = { productId: string; matchedOn: string; provenanceTier: ProvenanceTier };
export type TierInput = { products: Product[]; aliases: Alias[]; masterCandidates?: MasterCandidate[] };

export function resolveScanToProductTiered(
  cleaned: CleanedCode,
  input: TierInput,
  businessId: string,
): ScanResolution {
  // P2: tenant-only resolution, unchanged. masterCandidates intentionally unused until P5 (D5).
  void input.masterCandidates;
  return resolveScanToProduct(cleaned, input.products, input.aliases, businessId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/services/resolverTier.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing resolver suites (no regression)**

Run: `npm run test -- src/services/resolver.test.ts src/services/aliasMatcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/aliasMatcher.ts src/services/resolverTier.test.ts
git commit -m "feat(resolver): tenant-truth vs master-truth tier interface slot (P5 fills conflict logic)"
```

---

### Task 14: Destructive-action PIN guard (pure)

**Track:** T4. **Depends on:** none. **SERIALIZES before Task 15.**

**Files:**
- Create: `src/services/security/destructiveGuard.ts`
- Test: `src/services/security/destructiveGuard.test.ts`

**Interfaces:**
- Produces: `type DestructiveAction = "markWrong" | "removeFromCount" | "clearCache"`; `requiresOwnerPin(action: DestructiveAction, hasPin: boolean): boolean` (true when a PIN is set - gate applies; when no PIN set, falls back to window.confirm only, matching today, so a PIN-less owner is never locked out). Consumed by Task 15.

- [ ] **Step 1: Write the failing test**

```ts
// src/services/security/destructiveGuard.test.ts
import { describe, it, expect } from "vitest";
import { requiresOwnerPin } from "./destructiveGuard";

describe("requiresOwnerPin", () => {
  it("gates every destructive action when a PIN is set", () => {
    expect(requiresOwnerPin("markWrong", true)).toBe(true);
    expect(requiresOwnerPin("removeFromCount", true)).toBe(true);
    expect(requiresOwnerPin("clearCache", true)).toBe(true);
  });
  it("does not gate when no PIN is set (falls back to confirm, owner never locked out)", () => {
    expect(requiresOwnerPin("markWrong", false)).toBe(false);
    expect(requiresOwnerPin("clearCache", false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/services/security/destructiveGuard.test.ts`
Expected: FAIL ("Cannot find module './destructiveGuard'").

- [ ] **Step 3: Write the guard**

```ts
// src/services/security/destructiveGuard.ts
// Which destructive actions require the owner PIN before proceeding. Reuses the existing ownerPin
// hash machinery (settings.ownerPinHash, verifyOwnerPin in the store). When no PIN is set, we do NOT
// gate (the action still shows its window.confirm) so a PIN-less owner is never locked out - matching
// the SessionLockControl philosophy that a forgotten/absent PIN can never trap a count.

export type DestructiveAction = "markWrong" | "removeFromCount" | "clearCache";

export function requiresOwnerPin(action: DestructiveAction, hasPin: boolean): boolean {
  void action; // all three are equally destructive; the gate is uniform when a PIN exists
  return hasPin;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/services/security/destructiveGuard.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/security/destructiveGuard.ts src/services/security/destructiveGuard.test.ts
git commit -m "feat(safety): destructive-action owner-PIN gate policy"
```

---

### Task 15: Wire the PIN gate into clear-cache + count-removal UI (preserving the existing clear-cache body)

**Track:** T4. **Depends on:** Task 14.

**Files:**
- Modify: `src/app/(app)/settings/page.tsx` (`handleClearCache` at `:34-49`; the existing button at `:322-342` and its `clear-cache`/`clear-cache-message` testids stay AS-IS; only the PIN row is added)
- Modify: `src/components/FinalCountTable.tsx` (`removeFromCount` confirm at `:175`; markWrong path `:180-184` stays UI-dead behind `SHOW_ADVANCED_ACTIONS=false` at `:172`)
- Test: `src/components/settingsClearCache.pin.test.tsx`

**Interfaces:**
- Consumes: `requiresOwnerPin` (Task 14); store `verifyOwnerPin` (`scanStore.ts:1252-1269`) and `settings.ownerPinHash`.
- PRESERVATION CONTRACT (review finding): the current `handleClearCache` body does three things that MUST survive the PIN wrap: (1) `clearLocalCache()` + the reconcile store wipe, (2) `setCacheMsg("Local browser cache cleared. Cloud data was not deleted.")` shown via the existing `clear-cache-message` testid (`:337-339`), (3) the AM-R9 diagnostic `setTimeout(() => window.location.reload(), 1400)` (`:48`) so cloud data re-loads fresh and a returning poisoned alias is proven to live in cloud data. The gate wraps AROUND this body; it drops nothing.
- Note (scout-verified): markWrong is unreachable (`SHOW_ADVANCED_ACTIONS=false`, owner decision) - do NOT flip the flag. The Playwright proof (Task 16) exercises markWrong's PIN-policy surface via `window.__scanStore` per the Phase 1 ratified precedent, not the UI. This task wires the two REACHABLE destructive actions (clear-cache, removeFromCount).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/settingsClearCache.pin.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const verifyOwnerPin = vi.fn();
const clearLocalCache = vi.fn();

// The settings page selects many slices; the mock state must cover every selector it uses.
const storeState = {
  settings: { ownerPinHash: "hash" } as Record<string, unknown>,
  updateSettings: vi.fn(),
  businessId: "demo-business",
  clearLocalCache: () => clearLocalCache(),
  aiStatus: null,
  refreshAiStatus: vi.fn().mockResolvedValue(undefined),
  setEmergencyStop: vi.fn(),
  catalog: [] as unknown[],
  verifyOwnerPin: (p: string) => verifyOwnerPin(p),
};
vi.mock("@/stores/scanStore", () => ({
  useScanStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));
vi.mock("@/stores/reconcileStore", () => ({
  useReconcileStore: { getState: () => ({ clearLocalCache: vi.fn() }) },
}));
vi.mock("@/services/security/useAccessLevel", () => ({ useIsPlatformOwner: () => false }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("@/components/CleanupRecommendations", () => ({ CleanupRecommendations: () => null }));
vi.mock("@/components/OwnerPinSettings", () => ({ OwnerPinSettings: () => null }));
vi.mock("@/components/GptLadderPanel", () => ({ GptLadderPanel: () => null }));
vi.mock("@/components/GeminiStatusRow", () => ({ GeminiStatusRow: () => null }));

import SettingsPage from "@/app/(app)/settings/page";

beforeEach(() => {
  verifyOwnerPin.mockReset();
  clearLocalCache.mockReset();
  storeState.settings.ownerPinHash = "hash";
});

describe("clear cache PIN gate", () => {
  it("requires a correct PIN, then clears, shows the message, and schedules the AM-R9 reload", async () => {
    verifyOwnerPin.mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    const pinInput = await screen.findByTestId("clear-cache-pin");
    fireEvent.change(pinInput, { target: { value: "1234" } });
    fireEvent.click(screen.getByTestId("clear-cache-confirm"));
    await waitFor(() => expect(verifyOwnerPin).toHaveBeenCalledWith("1234"));
    await waitFor(() => expect(clearLocalCache).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("clear-cache-message")).toBeInTheDocument(); // cacheMsg preserved
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1400); // AM-R9 reload preserved
  });

  it("keeps today's confirm-only path when no PIN is set", async () => {
    storeState.settings.ownerPinHash = "";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await waitFor(() => expect(clearLocalCache).toHaveBeenCalledOnce()); // no PIN prompt, direct clear
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/settingsClearCache.pin.test.tsx`
Expected: FAIL (no `clear-cache-pin` element; the clear runs directly after confirm).

- [ ] **Step 3: Fold the PIN gate AROUND the existing handleClearCache body**

In `src/app/(app)/settings/page.tsx`, replace `handleClearCache` (`:34-49`) with the gate-wrapped version. IMPORTANT: the existing `const [cacheMsg, setCacheMsg] = useState("");` at `:33` is OUTSIDE the replaced range and STAYS - do NOT re-declare it (a duplicate declaration is a tsc error); add only the three new pin state hooks below. The inner `doClear()` is the CURRENT body verbatim (wipe + reconcile wipe + cacheMsg + AM-R9 reload), nothing dropped:

```tsx
  const hasPin = useScanStore((s) => !!s.settings.ownerPinHash);
  const verifyOwnerPin = useScanStore((s) => s.verifyOwnerPin);
  // cacheMsg/setCacheMsg already declared at :33 above this block - reuse, do not re-declare.
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState("");

  // The pre-existing clear-cache body, verbatim (AM-R9 preserved). The PIN gate wraps AROUND it.
  function doClear() {
    clearLocalCache();
    // AM-R9: the reconcile session is browser-local session state too - the same wipe clears it.
    useReconcileStore.getState().clearLocalCache();
    setCacheMsg("Local browser cache cleared. Cloud data was not deleted.");
    // Reload cleanly so cloud data re-loads fresh (and a poisoned alias that returns proves it is in
    // cloud data, to be fixed via the alias repair path, not local cache).
    if (typeof window !== "undefined") setTimeout(() => window.location.reload(), 1400);
    setPinPrompt(false);
    setPin("");
    setPinErr("");
  }

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

  async function submitPin() {
    const ok = await verifyOwnerPin(pin);
    if (!ok) { setPinErr("Wrong PIN"); return; }
    doClear();
  }
```

Add the import to the settings page (`useState`/`useEffect` are already imported at `:3`):

```tsx
import { requiresOwnerPin } from "@/services/security/destructiveGuard";
```

Leave the existing button (`data-testid="clear-cache"`, `:322-342`) and the `clear-cache-message` block (`:337-339`) untouched; ADD the PIN row directly after the message block:

```tsx
        {pinPrompt && (
          <div className="mt-2 flex items-center gap-2" data-testid="clear-cache-pin-row">
            <input aria-label="owner PIN" inputMode="numeric" value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={6}
              placeholder="Owner PIN" data-testid="clear-cache-pin"
              className="min-h-[44px] w-28 rounded-lg border border-zinc-300 px-3 text-base" />
            <button type="button" data-testid="clear-cache-confirm" onClick={submitPin}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-red-600 px-4 text-base font-medium text-white hover:bg-red-700">
              Confirm clear
            </button>
            {pinErr && <span className="text-sm text-red-600" data-testid="clear-cache-pin-error">{pinErr}</span>}
          </div>
        )}
```

- [ ] **Step 4: Gate removeFromCount the same way in FinalCountTable**

In `src/components/FinalCountTable.tsx`, where `removeFromCount` is triggered (confirm at `:175`; the markWrong path at `:180-184` stays UI-dead behind `SHOW_ADVANCED_ACTIONS=false` at `:172`; grep for `removeFromCount`/`window.confirm` rather than trusting line numbers), add the same PIN check: read `hasPin` (`!!s.settings.ownerPinHash`) + `verifyOwnerPin` from the store, and when `requiresOwnerPin("removeFromCount", hasPin)` is true, show an inline PIN input (testids `remove-pin`/`remove-pin-confirm`/`remove-pin-error`, same markup shape as the clear-cache PIN row above) and call `removeFromCount` only after `verifyOwnerPin(pin)` returns true; when no PIN is set, the existing confirm-only path runs unchanged. Leave the `markWrong` branch and `SHOW_ADVANCED_ACTIONS=false` untouched.

- [ ] **Step 5: Run the new test + existing FinalCountTable tests**

Run: `npm run test -- src/components/settingsClearCache.pin.test.tsx src/components/FinalCountTable.test.tsx`
Expected: PASS (existing FinalCountTable fixtures have no `ownerPinHash` set, so the confirm-only path still applies to them; if a fixture DOES set one, gate expectations change and that fixture keeps `ownerPinHash: ""` instead, noted in the commit).

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/settings/page.tsx src/components/FinalCountTable.tsx src/components/settingsClearCache.pin.test.tsx
git commit -m "feat(safety): owner-PIN gate on clear-cache and count-removal (AM-R9 body preserved)"
```

---

### Task 16: Playwright - auth flows + sign-out key removal + destructive-PIN proof (both viewports)

**Track:** T5. **Depends on:** Tasks 5, 8, 15 merged.

**Files:**
- Create: `e2e/p2-accounts.spec.ts` (mock-mode specs; live-auth flows use emulator config where noted)

**Interfaces:**
- Proves acceptance criteria #5 (Google + email sign-in + reset in browser, both viewports; sign-out clears local state INCLUDING the per-uid localStorage key being GONE) and #6 (destructive actions gated behind owner confirm/PIN; markWrong surface via `window.__scanStore`).

- [ ] **Step 1: Write the Playwright spec**

```ts
// e2e/p2-accounts.spec.ts
import { test, expect } from "@playwright/test";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`P2 accounts (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("login page shows email, Google, and reset affordances", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByTestId("login-email")).toBeVisible();
      await expect(page.getByTestId("login-google")).toBeVisible();
      await page.getByTestId("forgot-password").click();
      await expect(page.getByTestId("send-reset")).toBeVisible();
      await page.screenshot({ path: `e2e/proof/p2-login-${vp.name}.png` });
    });

    test("sign-out clears local scan state AND removes the per-uid persist key", async ({ page }) => {
      // Mock mode: the Nav logout button only renders in live mode, so the reset action is exercised
      // via the window.__scanStore hook (Phase 1 ratified precedent). Seed a fake signed-in identity
      // plus a fake per-uid localStorage key, then assert BOTH the in-memory wipe and the key removal.
      await page.goto("/scan");
      await page.evaluate(() => {
        window.localStorage.setItem("sis-scan-test-uid", JSON.stringify({ state: {}, version: 8 }));
        const s = (window as unknown as { __scanStore?: { setState: (p: object) => void } }).__scanStore;
        s?.setState({ userId: "test-uid", scanFeed: [{ id: "leak" }], needsReviewQueue: [{ id: "leak-r" }] });
      });
      await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { getState: () => { resetForSignOut: () => void } } }).__scanStore;
        s?.getState().resetForSignOut();
      });
      const after = await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { getState: () => { scanFeed: unknown[]; userId: string | null } } }).__scanStore;
        return {
          feedLen: s?.getState().scanFeed.length ?? -1,
          userId: s?.getState().userId ?? "unset",
          uidKeyGone: window.localStorage.getItem("sis-scan-test-uid") === null,
        };
      });
      expect(after.feedLen).toBe(0);
      expect(after.userId).toBeNull();
      expect(after.uidKeyGone).toBe(true); // the signed-out user's blob is GONE, not just reset in memory
      await page.screenshot({ path: `e2e/proof/p2-signout-${vp.name}.png` });
    });

    test("destructive PIN policy surface exists on the store (markWrong class, __scanStore proof)", async ({ page }) => {
      // markWrong is UI-dead by owner decision (SHOW_ADVANCED_ACTIONS=false); assert the policy inputs
      // it depends on are live: no PIN set by default -> confirm-only path (requiresOwnerPin false).
      await page.goto("/scan");
      const pinHash = await page.evaluate(() => {
        const s = (window as unknown as { __scanStore?: { getState: () => { settings: { ownerPinHash: string } } } }).__scanStore;
        return s?.getState().settings.ownerPinHash ?? null;
      });
      expect(pinHash).toBe(""); // default: no PIN, confirm-only fallback active
      await page.screenshot({ path: `e2e/proof/p2-markwrong-${vp.name}.png` });
    });
  });
}
```

- [ ] **Step 2: Run the E2E spec (mock webServer, IS_E2E=1)**

Run: `npm run test:e2e -- p2-accounts`
Expected: PASS on both viewports; screenshots written to `e2e/proof/`.

- [ ] **Step 3: Commit**

```bash
git add e2e/p2-accounts.spec.ts e2e/proof
git commit -m "test(e2e): P2 auth flows + sign-out key removal + destructive PIN proof (both viewports)"
```

---

### Task 17: Adopt-flow replay proof + full gate sweep

**Track:** T5. **Depends on:** all prior tasks merged.

**Files:**
- Create: `src/stores/adoptFlowReplay.store.test.ts` (proves owner's existing local data intact after the owner-initiated adopt, per acceptance criterion #4)

**Interfaces:**
- Proves acceptance criterion #4 (owner's local data intact after adopt: per-product quantities identical before/after, and the legacy blob consumed) and runs the full gate sweep. Uses the Task 6 helpers directly (pure storage-level proof; no store instance needed, so `createTestScanStore` from `scanStore.ts:5291` is not required here).

- [ ] **Step 1: Write the replay test**

```ts
// src/stores/adoptFlowReplay.store.test.ts
import { describe, it, expect } from "vitest";
import { migrateLegacyBlobOnce, persistKeyForUid } from "./scanPersistNamespace";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

// Sums feed deltas per product, the same invariant P1's ledger tooling asserts.
function quantitiesByProduct(feed: Array<{ productId?: string; quantityDelta?: number }>) {
  const out: Record<string, number> = {};
  for (const r of feed) {
    if (!r.productId) continue;
    out[r.productId] = (out[r.productId] ?? 0) + (r.quantityDelta === 0 ? 1 : r.quantityDelta ?? 1);
  }
  return out;
}

describe("adopt-flow replay: owner data intact after the owner-initiated adopt", () => {
  it("per-product quantities identical before/after; legacy blob consumed", () => {
    const s = new MemStorage();
    const legacyFeed = [
      { id: "e1", productId: "p1", quantityDelta: 1 },
      { id: "e2", productId: "p1", quantityDelta: 1 },
      { id: "e3", productId: "p2", quantityDelta: 3 },
      { id: "e4", productId: "p2", quantityDelta: 0 }, // pre-D1 ghost -> normalizes to 1
    ];
    s.setItem("sis-scan-v1", JSON.stringify({ state: { scanFeed: legacyFeed, businessId: "b1" }, version: 8 }));

    const before = quantitiesByProduct(legacyFeed); // p1:2, p2:4 (0 counted as 1 by the invariant helper)
    migrateLegacyBlobOnce("owner-uid", s as unknown as Storage);
    const migrated = JSON.parse(s.getItem(persistKeyForUid("owner-uid"))!).state.scanFeed;
    const after = quantitiesByProduct(migrated);

    expect(after).toEqual(before);
    expect(after.p1).toBe(2);
    expect(after.p2).toBe(4);
    expect(s.getItem("sis-scan-v1")).toBeNull(); // adopt CONSUMES the legacy blob (no double-inherit)
  });
});
```

- [ ] **Step 2: Run the replay test**

Run: `npm run test -- src/stores/adoptFlowReplay.store.test.ts`
Expected: PASS.

- [ ] **Step 3: Full unit sweep in mock/default mode**

Run: `npm run test`
Expected: PASS. All existing suites (2294+ unit) green in the default `mock`/`AUTH_MODE` unset environment. (The `*.rules.test.ts` files self-skip without the emulator by design; that is expected.) If any suite fails only because it asserted the old un-clamped/un-recomputed behavior, fix that assertion to the new server-trust behavior and note it in the commit body.

- [ ] **Step 4: Lint + typecheck + build**

Run: `npm run lint`
Expected: PASS (no new lint errors).

Run: `npx tsc --noEmit`
Expected: PASS (types consistent across new modules, including the pipeline's required `paidComputeCharged`).

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Emulator rules + emulator-backed isolation sweep**

Run: `npm run test:firebase`
Expected: PASS (rules suites including the extended catalogEntries/retailCatalogEntries deny cases). $0, local emulator.

- [ ] **Step 6: Commit**

```bash
git add src/stores/adoptFlowReplay.store.test.ts
git commit -m "test(tenancy): adopt-flow replay proof (quantities invariant + legacy blob consumed)"
```

---

## Acceptance criteria mapping (master-plan P2 #1-6)

| # | Criterion | Tasks that satisfy it |
|---|---|---|
| 1 | Two accounts cannot see each other's data, proven at BOTH layers (Firestore rules emulator AND localStorage: sign out A, sign in B -> zero of A's rows) | Task 12 (rules), Task 7 (full tenant-state replacement incl. one-user-two-businesses) + Task 8 (per-uid namespace, sign-out clear + key removal, chokepoint reads 2-3 so live mode actually engages, owner-adopt so B never inherits A's blob), Task 16 (browser proof incl. key-gone assertion) |
| 2 | Tenant client writes to `catalogEntries` REJECTED; master corpus untouched (read-only runtime, no write API) | Task 12 (extended deny cases incl. owner-authority and retailCatalogEntries); Task 13 note asserts resolver takes no master-write path; the P2 invariant is asserted by ABSENCE of a client/tenant writer (scout-confirmed none exists) |
| 3 | Unauthenticated API calls rejected in live mode; client-sent `codeType`/`confidenceThreshold` demonstrably ignored | Task 10 (live-mode auth 401/403 with gate-before-quota ordering locked, server codeType recompute, server-authoritative scanContext + autoCount flag, account charge on the paid signal only), Task 9 (threshold clamp), Task 11 (quota primitives) |
| 4 | Owner's existing local data intact after adopt flow: per-product quantities identical before/after (P1 replay tooling) | Task 6 (owner-adopt migration + quantityDelta fold-in + legacy consumption), Task 8 (adopt banner: explicit owner choice), Task 17 (replay proof) |
| 5 | Google + email sign-in + reset proven in browser (both viewports); sign-out clears local state | Task 3, Task 5 (auth surface), Task 8 (sign-out clear + key removal), Task 16 (Playwright both viewports) |
| 6 | Destructive actions gated behind owner confirm | Task 14 (policy), Task 15 (clear-cache + removeFromCount wiring with the AM-R9 body preserved), Task 16 (markWrong-class surface via __scanStore) |

---

## Self-Review (run before saving)

**1. Spec coverage.** Every P2 acceptance criterion (1-6) maps to at least one task (table above). AUTH_MODE chokepoint (master-plan:103) = Tasks 1-2, consumed by 4/8/10, with ALL THREE legacy env reads migrated (AuthGuard in Task 4; BusinessContextGate + Nav in Task 8, regression-locked by `BusinessContextGate.authmode.test.tsx`). Two-database "stores named precisely" (master-plan:96-99): tenant DB isolation = Tasks 7/8/12; master corpus read-only = asserted by absence (Task 13 note); master append surface deny = Task 12; the master-append WRITE path is correctly EXCLUDED (scout-rules: net-new, P5 owns it) and stated so. Resolver tier interface (master-plan:100) = Task 13. Server-trust D4 (master-plan:101) = Tasks 9/10/11, now covering the FULL client-input surface (codeType, threshold, scanContext, autoCount flag) with gate-before-quota ordering and the paid-compute charge signal. Destructive-action guard (master-plan:102) = Tasks 14/15. Deferred items (export/deletion/plan-shape) correctly NOT planned. GAP CHECK: none found.

**2. Placeholder scan.** No "TBD"/"implement later"/"add error handling" left. The former hedges ("placeholder for the real factory", "if DEFAULT_SETTINGS is exported elsewhere", "if NeedsReviewItem is named differently", "import updateDoc/deleteDoc if not already imported", "add runtime if not already present") are all DELETED and replaced with repo-verified facts: `createTestScanStore` from `scanStore.ts:5291`, `DEFAULT_SETTINGS` from `scanStore.ts:438`, `UnknownCodeReview` from `types.ts:244`, `updateDoc`/`deleteDoc` already imported at `tenantIsolation.rules.test.ts:3`, `runtime` verified absent (unconditional add). Every code step shows complete code; Task 15 Step 4 describes the FinalCountTable wiring against verified line sites with the exact policy call and testids.

**3. Type consistency.** `getAuthMode/isLiveAuth/isOpenAccess` (Task 2) used identically in Tasks 4/8/10. `persistKeyForUid`/`hasLegacyBlob`/`migrateLegacyBlobOnce` (Task 6) used in Tasks 8/16/17 with matching signatures. `emptyTenantState` (Task 7, four fields) matches its uses in Tasks 7/8. `clampConfidenceThreshold` (Task 9) used in Task 10. `perAccountDailyKey`/`readDailyUsedForAccount`/`chargeDailySlotForAccount` (Task 11) used in Task 10. `paidComputeCharged` (Task 10 Step 6a) consumed in Step 6c and asserted in the D4 test and Task 17 typecheck. `requiresOwnerPin`/`DestructiveAction` (Task 14) used in Task 15. `resolveScanToProductTiered`/`MasterCandidate`/`TierInput` (Task 13) self-consistent. `resetForSignOut`/`rehydrateForUid`/`adoptLegacyLocalData` (Task 8) match their store-interface declarations and their consumers (BusinessContextGate, Nav, business page, Task 16 spec).

**4. Track/dependency consistency.** Execution mechanics are SINGLE CHECKOUT with orchestrator-serial commits (worktrees rejected: Windows node_modules cost). T2-chokepoint (Tasks 1-2) is the sole cross-track dependency (S1), consumed by disjoint-file tasks 4/8/10. Within-track serialization stated (T3: 6->7->8; T4: 14->15). Every file edited in a task appears in that task's Files header AND its track's File Structure list, including `BusinessContextGate.tsx` and `pipeline.ts` (both previously missing, now listed in T3/T2 respectively). Tracks touch disjoint files, so parallel subagents cannot collide.

## P2 spec items NOT groundable in scout evidence (flagged for the executor/owner)

- **Master-append WRITE path** ("strong-confidence app-verified ladder results append here as master truth (server-side)", master-plan:99): scout-rules confirms this writer does not exist anywhere in `src/` and is 100% net-new. This plan deliberately does NOT build it (it defines the interface + preserves the deny invariant only). If the owner intends the writer inside P2 rather than P5, that is a scope expansion needing a new task and an owner decision.
- **Per-business settings LOADING from Firestore**: `loadBusinessData` does not fetch `settings` (scout-tenancy). P2 resets settings to defaults on switch (isolation-correct); actually LOADING a tenant's saved settings is P3 sync work, not grounded as a P2 deliverable. Stated in Task 7's note.
- **Live-mode tire context**: with `scanContext` now server-authoritative in live mode (Task 10), a live deployment opts into the tire context via `AI_LIVE_SCAN_CONTEXT=tire` (env policy) until P3's settings sync can derive it from the business's own stored settings. This is the conservative reading of the D4 ruling; the owner may prefer a different live default - flag at execution if so.
