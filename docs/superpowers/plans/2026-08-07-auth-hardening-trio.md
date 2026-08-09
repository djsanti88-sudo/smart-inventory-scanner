# Auth Hardening Trio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three small unlocked doors: (A) rate-limit the account-delete route, (B) send + surface email verification without ever blocking scanning, (C) get the 22-commit local-only `audit-fixes` branch reviewed and landed (push/PR owner-gated).

**Architecture:** (A) copies the exact, already-hardened `checkRateLimit` pattern from the export route into the delete route (durable Turso-backed limiter, fail-closed, keyed on verified identities only). (B) adds `sendEmailVerification` on password sign-up in `src/lib/auth.ts` (Google accounts arrive verified) plus a dismissable non-blocking banner with a resend button; NO hard gate - the TOP-LEVEL LAW and the offline-first product mean scanning must never be held hostage to email. (C) is a review-and-land procedure, not code: rebase-check the stale branch against a master that has moved ~10 PRs since, run the full gate battery, then the owner decides push/PR.

**Tech Stack:** Next.js API routes, `aiSpendGuard.checkRateLimit` + `ladderStorage()` (Turso), Firebase Auth `sendEmailVerification`, Vitest, existing route test patterns.

## Global Constraints

- TOP-LEVEL LAW: nothing here may block, hide, or gate scanning. Email verification is a banner, never a wall.
- No em or en dash in user-facing copy. Normal punctuation.
- API keys and admin SDK stay server-side; no client `process.env.*_API_KEY` reads.
- Rate limiter keys use ONLY verified identities (uid, businessId) - never client-controlled headers (`x-forwarded-for` is spoofable; the export route comment at `src/app/api/account/export/route.ts:175-178` is the law here).
- git push / PR creation is OWNER-GATED. Task C prepares; the owner fires.
- Wrong identity is worse than unknown; unrelated to these changes but no task may touch resolver/ledger code.

## File Structure

- Modify: `src/app/api/account/delete/route.ts` - add rate limit after role verification, before phrase check.
- Test: `src/app/api/account/delete/route.ratelimit.test.ts` - new; mock `checkRateLimit`.
- Modify: `src/lib/auth.ts` - send verification email in `signUp` (fire-and-forget, fail-soft).
- Create: `src/components/EmailVerifyBanner.tsx` + `src/components/EmailVerifyBanner.test.tsx` - banner + resend.
- Create: `src/components/EmailVerifyBannerGate.tsx` - tiny `"use client"` wrapper that subscribes to auth state via the existing `onAuthChange` (`src/lib/auth.ts:54`) and renders `<EmailVerifyBanner user={user} />`. Needed because `src/app/(app)/layout.tsx` is a SERVER component (no hooks) - review finding I1.
- Modify: `src/app/(app)/layout.tsx` - mount `<EmailVerifyBannerGate />` next to the existing `<ProdFirebaseBanner />` (the app-wide banner slot; NOT `KillSwitchBanner`, which lives only inside `src/app/(app)/settings/page.tsx:312` and would scope the nudge to Settings).
- No files for Task C (procedure + gate runs only).

---

### Task A: Rate-limit the delete route

**Files:**
- Modify: `src/app/api/account/delete/route.ts` (imports at top; limiter block between role check ~line 127 and phrase check ~line 132)
- Test: `src/app/api/account/delete/route.ratelimit.test.ts`

**Interfaces:**
- Consumes: `checkRateLimit`, `intEnv` from `@/services/security/aiSpendGuard`; `ladderStorage` from `@/server/upc/storage`; `logServerEvent` from `@/server/log` (all exactly as the export route consumes them - see `src/app/api/account/export/route.ts:8-10,179-192`).
- Produces: 429 with `Retry-After` header when a verified owner hammers deletion. Env knobs: `ACCOUNT_DELETE_RATE_LIMIT` (default 3), `ACCOUNT_DELETE_RATE_WINDOW_MS` (default 3,600,000 = 1 hour). Placement rationale: AFTER role verification (rejected non-owners never consume the bucket, mirroring export), BEFORE the phrase check (a phrase-guessing loop is exactly the abuse this bounds).

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/account/delete/route.ratelimit.test.ts
// Pattern reference: mirror the existing export-route tests' mocking style if present
// (check src/app/api/account/export/*.test.ts first and align module mocks with it).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn(async () => ({ uid: "owner-uid" })) }),
  getAdminDb: () => ({
    doc: vi.fn(() => ({
      get: vi.fn(async () => ({ exists: true, data: () => ({ role: "owner" }) })),
    })),
    collection: vi.fn(),
    recursiveDelete: vi.fn(async () => undefined),
  }),
}));
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/server/upc/storage", () => ({ ladderStorage: vi.fn(async () => ({})) }));
vi.mock("@/server/log", () => ({ logServerEvent: vi.fn() }));

const checkRateLimit = vi.fn();
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return { ...real, checkRateLimit: (...args: unknown[]) => checkRateLimit(...args) };
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/delete", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_BODY = { businessId: "biz-1", idToken: "tok", confirmPhrase: "DELETE MY ACCOUNT" };

describe("delete route rate limiting", () => {
  beforeEach(() => {
    vi.resetModules();
    checkRateLimit.mockReset();
    process.env.IS_E2E = "";
  });

  it("returns 429 with Retry-After when the limiter denies", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 120_000 });
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("keys the limiter on verified identities only (DELETE:<businessId>:<uid>)", async () => {
    checkRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    const { POST } = await import("./route");
    await POST(makeRequest(VALID_BODY));
    expect(checkRateLimit).toHaveBeenCalledWith(
      "DELETE:biz-1:owner-uid",
      expect.objectContaining({ failClosedOnStorageError: true }),
    );
  });

  it("fails closed when limiter storage errors (503, deletion does NOT run)", async () => {
    checkRateLimit.mockRejectedValue(new Error("turso down"));
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
  });

  it("does not consume the bucket for non-owners (limiter never called)", async () => {
    // Re-mock membership as counter role for this case.
    vi.doMock("@/lib/firebaseAdmin", () => ({
      getAdminAuth: () => ({ verifyIdToken: vi.fn(async () => ({ uid: "counter-uid" })) }),
      getAdminDb: () => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({ exists: true, data: () => ({ role: "counter" }) })),
        })),
        collection: vi.fn(),
        recursiveDelete: vi.fn(),
      }),
    }));
    const { POST } = await import("./route");
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/app/api/account/delete/route.ratelimit.test.ts`
Expected: FAIL (429/limiter behavior not implemented).

- [ ] **Step 3: Implement** - in `src/app/api/account/delete/route.ts`:

Add imports (top, matching export route):

```typescript
import { intEnv, checkRateLimit } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import { logServerEvent } from "@/server/log";
```

Insert between the role check (`if (memberRole !== "owner") {...}` ending ~line 127) and the confirm-phrase check (~line 132):

```typescript
  // Rate limit AFTER role verification (rejected non-owners never consume the owner's bucket,
  // mirroring the export route) and BEFORE the phrase check (a phrase-guessing loop is exactly
  // the abuse this bounds). Durable Turso-backed limiter; verified identities only in the key;
  // fail CLOSED - if the limiter store is down we refuse an irreversible action rather than
  // allow an unmetered one.
  try {
    const rl = await checkRateLimit(`DELETE:${businessId}:${uid}`, {
      limit: intEnv(process.env.ACCOUNT_DELETE_RATE_LIMIT, 3),
      windowMs: intEnv(process.env.ACCOUNT_DELETE_RATE_WINDOW_MS, 3_600_000),
      storage: await ladderStorage(),
      failClosedOnStorageError: true,
    });
    if (!rl.allowed) {
      logServerEvent({ route: "/api/account/delete", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
      return NextResponse.json(
        { error: "Too many deletion attempts. Wait and try again.", retryAfterMs: rl.retryAfterMs },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  } catch (error) {
    logServerEvent({ route: "/api/account/delete", event: "error", reasonCode: "rate_limit_storage_failed", status: 503 });
    return json({ error: "Could not verify request rate. Try again shortly." }, 503);
  }
```

IMPLEMENTER NOTE: open `src/app/api/account/export/route.ts:179-196` first and copy its exact call shape/fields - if `checkRateLimit`'s options differ from this plan (the export route is truth), follow the export route. Also verify `logServerEvent`'s accepted fields against `src/server/log.ts` (sanitization law) - drop any field it rejects.

- [ ] **Step 4 (REQUIRED, not contingency - review finding I2): Update the existing `src/app/api/account/delete/route.test.ts`**

That suite mocks ONLY `@/lib/firebaseAdmin`. Once the limiter runs before the phrase check, every existing case (owner delete, phrase-mismatch 400, etc.) would hit the REAL `await ladderStorage()` (better-sqlite3/Turso at cwd) + real `checkRateLimit` with `failClosedOnStorageError: true` - flaky disk I/O at best, hard 503 failures at worst. Add to that file's setup, mirroring the new test's mocks:

```typescript
vi.mock("@/server/upc/storage", () => ({ ladderStorage: vi.fn(async () => ({})) }));
vi.mock("@/services/security/aiSpendGuard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/security/aiSpendGuard")>();
  return { ...real, checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0, remaining: 99 })) };
});
vi.mock("@/server/log", () => ({ logServerEvent: vi.fn() }));
```

Do not weaken or delete any existing assertion.

- [ ] **Step 5: Run the new test + the existing delete-route suite**

Run: `npx vitest run src/app/api/account/delete/`
Expected: PASS all.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/account/delete/
git commit -m "sec: durable fail-closed rate limit on account deletion (DELETE:<biz>:<uid>, 3/hour default)"
```

---

### Task B: Email verification - send on signup + non-blocking banner

**Files:**
- Modify: `src/lib/auth.ts` (`signUp`, ~line 267)
- Create: `src/components/EmailVerifyBanner.tsx`
- Test: `src/components/EmailVerifyBanner.test.tsx`
- Modify: signed-in shell to mount the banner (locate the existing kill-switch banner mount point - `grep -rn "KillSwitchBanner" src/` - and mount beside it; that component already solved "banner inside the app shell")

**Interfaces:**
- Consumes: Firebase Auth `sendEmailVerification` (from `firebase/auth`), existing `getFirebaseAuth()`, existing auth state hook (locate: `grep -rn "onAuthStateChanged\|useAuthState\|currentUser" src/components src/lib` and reuse the app's existing pattern - do NOT invent a new auth listener).
- Produces: verification email fires on password sign-up (fail-soft); banner reading "Verify your email. We sent a link to <email>." with a "Resend" button, shown only when `user.emailVerified === false` and provider is `password`; dismiss persists for the session (sessionStorage). NO route gating anywhere.

Decision note (for reviewer): hard-gating any feature on verification was rejected - Google users arrive pre-verified, scanner stations often run on shared devices where email is inaccessible, and the TOP-LEVEL LAW forbids blocking scan flow. The banner closes the "fake email signup" gap enough for now: the account works, but the user is told their recovery path is dead until verified.

- [ ] **Step 1: Write the failing banner test**

```tsx
// src/components/EmailVerifyBanner.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const sendEmailVerification = vi.fn(async () => undefined);
vi.mock("firebase/auth", () => ({ sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...a) }));

// The banner takes the user as a prop (dumb component) so tests need no auth harness and the
// mount point wires it to the app's existing auth state source.
import { EmailVerifyBanner } from "./EmailVerifyBanner";

const unverifiedPasswordUser = {
  email: "shop@example.com",
  emailVerified: false,
  providerData: [{ providerId: "password" }],
} as never;

describe("EmailVerifyBanner", () => {
  beforeEach(() => {
    sessionStorage.clear();
    sendEmailVerification.mockClear();
  });

  it("shows for an unverified password user", () => {
    render(<EmailVerifyBanner user={unverifiedPasswordUser} />);
    expect(screen.getByText(/Verify your email/i)).toBeInTheDocument();
    expect(screen.getByText(/shop@example.com/)).toBeInTheDocument();
  });

  it("hides for a verified user", () => {
    render(<EmailVerifyBanner user={{ ...unverifiedPasswordUser, emailVerified: true } as never} />);
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("hides for a Google user regardless of flag", () => {
    render(
      <EmailVerifyBanner
        user={{ ...unverifiedPasswordUser, providerData: [{ providerId: "google.com" }] } as never}
      />,
    );
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("hides when user is null (signed out / mock mode)", () => {
    render(<EmailVerifyBanner user={null} />);
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("resend calls sendEmailVerification and confirms", async () => {
    render(<EmailVerifyBanner user={unverifiedPasswordUser} />);
    fireEvent.click(screen.getByRole("button", { name: /resend/i }));
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Sent/i)).toBeInTheDocument();
  });

  it("dismiss hides it and persists for the session", () => {
    const { unmount } = render(<EmailVerifyBanner user={unverifiedPasswordUser} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
    unmount();
    render(<EmailVerifyBanner user={unverifiedPasswordUser} />);
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/EmailVerifyBanner.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the banner**

```tsx
// src/components/EmailVerifyBanner.tsx
"use client";

import { useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import type { User } from "firebase/auth";

const DISMISS_KEY = "sis-verify-banner-dismissed";

/** Non-blocking email-verification nudge. Shows ONLY for password-provider users whose email is
 *  unverified. Never gates any route or the scan flow (TOP-LEVEL LAW). Dumb component: the caller
 *  passes the current user from the app's existing auth state source. */
export function EmailVerifyBanner({ user }: { user: User | null }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  const isUnverifiedPasswordUser =
    !!user &&
    !user.emailVerified &&
    user.providerData.some((p) => p.providerId === "password");

  if (!isUnverifiedPasswordUser || dismissed) return null;

  const resend = async () => {
    setSending(true);
    try {
      await sendEmailVerification(user);
      setSent(true);
    } catch {
      // Fail soft: a resend failure is not worth an error state in a nudge banner.
      setSent(true);
    } finally {
      setSending(false);
    }
  };

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* session-only dismiss still works in memory */
    }
  };

  return (
    <div role="status" className="flex items-center gap-3 bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-2">
      <span>
        Verify your email. We sent a link to {user.email}. Until you verify, password recovery for
        this account will not work.
      </span>
      {sent ? (
        <span className="font-medium">Sent.</span>
      ) : (
        <button type="button" onClick={resend} disabled={sending} className="underline font-medium disabled:opacity-50">
          Resend
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="ml-auto font-medium">
        Dismiss
      </button>
    </div>
  );
}
```

STYLING NOTE: match the existing kill-switch banner's classes/tokens once located; the classes above are a placeholder to be aligned, not a new design.

- [ ] **Step 4: Send verification on password sign-up** - in `src/lib/auth.ts` `signUp` (~line 267), after `createUserWithEmailAndPassword` succeeds and BEFORE `finishAuthentication`:

```typescript
export async function signUp(email: string, password: string): Promise<AuthFlowResult> {
  try {
    const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
    // Fire-and-forget verification email: signup must never fail because the mail send did
    // (fail-soft; the in-app banner offers resend).
    sendEmailVerification(cred.user).catch(() => undefined);
    return finishAuthentication(cred.user, true);
  } catch (e) {
    return {
      status: "auth_failed",
      accountCreated: false,
      businessId: null,
      error: firebaseAuthErrorMessage(e),
    };
  }
}
```

(Add `sendEmailVerification` to the existing `firebase/auth` import in that file.)

- [ ] **Step 5: Mount the banner via a client gate** - create the wrapper and mount it in the server layout:

```tsx
// src/components/EmailVerifyBannerGate.tsx
"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { onAuthChange } from "@/lib/auth";
import { EmailVerifyBanner } from "./EmailVerifyBanner";

/** Client-side auth subscription for the server (app) layout. In mock mode there is no user,
 *  so this renders nothing (banner's null guard). */
export function EmailVerifyBannerGate() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthChange(setUser), []);
  return <EmailVerifyBanner user={user} />;
}
```

IMPLEMENTER NOTE: read `src/lib/auth.ts:54` first - if `onAuthChange`'s callback delivers a wrapped shape rather than a raw `User | null`, adapt the setter (and unsubscribe return) to the real signature. Then in `src/app/(app)/layout.tsx`, render `<EmailVerifyBannerGate />` immediately next to the existing `<ProdFirebaseBanner />`.

- [ ] **Step 6: Run component + auth suites, then E2E smoke**

Run: `npx vitest run src/components/EmailVerifyBanner.test.tsx src/lib/` then `npm run test:e2e`
Expected: PASS; E2E unaffected (mock mode = no user = no banner).

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth.ts src/components/EmailVerifyBanner.tsx src/components/EmailVerifyBanner.test.tsx src/app
git commit -m "feat: send verification email on signup + non-blocking verify banner with resend"
```

---

### Task C: Land the audit-fixes branch (procedure; push/PR OWNER-GATED)

**Files:**
- None created. Gate runs + a written verdict appended to `PROGRESS.md`.

**Interfaces:**
- Consumes: local branch `audit-fixes` (22 commits ahead of the 2026-07-29 master per `REPO_HEALTH.md` CRITICAL #1; master has since moved through PRs #27-#31, so drift is CERTAIN and merge conflicts are likely).
- Produces: a rebased (or re-evaluated) branch + a go/no-go summary for the owner. The owner fires the push and PR.

- [ ] **Step 1: Inventory the drift (read-only)**

```bash
git log --oneline master..audit-fixes            # the 22 commits
git log --oneline audit-fixes..master | head -50 # what master gained since (PRs 27-31 era)
git diff --stat master...audit-fixes             # files the branch touches
git diff --name-only master...audit-fixes > /tmp/af-files.txt
git log --oneline master -- $(cat /tmp/af-files.txt | head -20) | head -30  # overlap heat check
```

Record: how many of the branch's files master also changed since 2026-07-29. High overlap in `scanStore.ts` / `pipeline.ts` / API routes means per-commit conflict review, not a blind rebase.

- [ ] **Step 2: Check for superseded work** - for each of the 22 commits, one line: still-needed / already-landed-differently (canelo round 2 and PR #30/#31 fixed overlapping areas: retry poisoning, env manifest, sign-in re-scope) / obsolete. Evidence: `git log --grep` on master for matching subjects + spot-diff. THIS IS THE KEY STEP - a stale security branch can silently REVERT newer fixes if merged carelessly.

- [ ] **Step 3: Rebase onto master in a worktree (never on the main checkout)**

```bash
git worktree add C:/tmp/wt-audit-fixes-rebase audit-fixes
cd C:/tmp/wt-audit-fixes-rebase
git rebase master   # resolve conflicts commit by commit, guided by the Step 2 verdict table;
                    # DROP commits marked already-landed/obsolete during the rebase rather than
                    # merging stale versions over newer master code
```

- [ ] **Step 4: Full gate battery on the rebased branch**

Run, in the worktree: `npm ci && npm run proof:local && npm run test:ledger && npm run test:firebase && npm run build`
Expected: all green. Any failure gets root-caused (systematic-debugging), never test-weakened.

- [ ] **Step 5: Write the verdict + hand to owner (OWNER GATE)** - append to `PROGRESS.md`: kept/dropped commit table, gate results, conflict notes. Then present to the owner: push `audit-fixes-rebased` + open PR? The push and the PR are the owner's call; provide the exact commands but do not run them:

```bash
git push -u origin audit-fixes            # OWNER-GATED
gh pr create --base master --head audit-fixes --title "Audit remediation (2026-07-29 batch, rebased)" \
  --body "22-commit audit remediation rebased onto current master; drift verdict table in PROGRESS.md"
```

---

## Risks / notes

- Task A fail-closed choice: if Turso is down, deletion returns 503. That is the correct bias for an irreversible action (export made the same call).
- Task B deliberately does NOT enforce verification. If the owner later wants a hard gate (e.g. before enabling live decode for a business), that is a one-line check on `user.emailVerified` at that specific feature gate, not a route wall.
- Task C is where the real risk lives: a 10-day-stale security branch merged over canelo-round-2 code could reintroduce fixed bugs. The Step 2 supersession table is the safety mechanism; do not skip it to save time.
