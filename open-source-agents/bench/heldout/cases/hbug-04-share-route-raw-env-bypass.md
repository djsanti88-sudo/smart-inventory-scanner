# Case: hbug-04-share-route-raw-env-bypass
## Task prompt (what the subject model sees)
Review the following code for real defects. This is a Next.js API route that mints an expiring,
read-only shareable "Boss Report" snapshot link for a multi-tenant inventory SaaS. In live mode the
caller must present a valid Firebase ID token and be a verified member of the requested business
before a token is minted; there is also an explicit, documented credential-free bypass used only by
mock mode and by automated/demo tooling (E2E tests, local demos).
## Input code
```ts
// src/app/api/share/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  mintShareToken,
  normalizeBossReportSnapshot,
} from "@/server/share/shareTokenStore";
import { buildBossReport } from "@/services/reports/bossReport";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/services/auth/authMode";

export const runtime = "nodejs";

const SHARE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_SHARE_SNAPSHOT_BYTES = 32 * 1024;

type ShareRequestBody = {
  sessionId?: unknown;
  businessId?: unknown;
  idToken?: unknown;
  reportSnapshot?: unknown;
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(
    message,
  );
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

// Mints an expiring, read-only Boss Report snapshot. Live mode authenticates the caller and checks
// membership before minting. Mock mode and IS_E2E=1 are the explicit credential-free demo paths.
export async function POST(request: NextRequest) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SHARE_SNAPSHOT_BYTES) {
    return json({ error: "Report snapshot must be 32KB or smaller." }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_SHARE_SNAPSHOT_BYTES) {
    return json({ error: "Report snapshot must be 32KB or smaller." }, 413);
  }

  let body: ShareRequestBody;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body shape");
    }
    body = parsed as ShareRequestBody;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const sessionId = stringField(body.sessionId);
  if (!sessionId) {
    return json({ error: "A session is required before creating a shareable link." }, 400);
  }

  const requestedBusinessId = stringField(body.businessId);
  const authBypass = process.env.IS_E2E === "1" || !isLiveAuth();
  if (!authBypass) {
    const idToken = stringField(body.idToken);
    if (!idToken) return json({ error: "Sign in required." }, 401);
    if (!requestedBusinessId) return json({ error: "Missing businessId." }, 400);

    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (error) {
      if (authConfigurationError(error)) {
        return json({ error: "Server auth is not configured." }, 503);
      }
      return json({ error: "Invalid or expired sign-in." }, 401);
    }

    try {
      const member = await getAdminDb()
        .doc(`${COLLECTIONS.businessMembers}/${memberDocId(requestedBusinessId, uid)}`)
        .get();
      if (!member.exists) {
        return json({ error: "Not a member of this business." }, 403);
      }
    } catch (error) {
      if (authConfigurationError(error)) {
        return json({ error: "Server auth is not configured." }, 503);
      }
      return json({ error: "Could not verify business membership." }, 503);
    }
  }

  const businessId = requestedBusinessId || "demo-business";
  const fallbackReport = buildBossReport({
    products: [],
    finalCounts: [],
    scanFeed: [],
    sessionName: "Untitled session",
    countedBy: "Owner",
    countedAt: new Date().toISOString(),
  });
  const reportSnapshot = normalizeBossReportSnapshot(body.reportSnapshot ?? fallbackReport);
  const now = Date.now();
  const token = await mintShareToken(
    {
      businessId,
      sessionId,
      reportSnapshot,
      createdAt: now,
      expiresAt: now + SHARE_TTL_MS,
    },
    SHARE_TTL_MS,
  );

  return json({ token, url: `${request.nextUrl.origin}/report/${token}` });
}
```
## GROUND TRUTH (never shown to subject)
- Defect: the credential-free bypass is gated on a raw environment-variable read,
  `process.env.IS_E2E === "1"`, with no scoping to `NODE_ENV`. `IS_E2E` is meant to be set only in
  the Playwright/E2E test runner's environment, but nothing in this route (or in `isLiveAuth()`, which
  only governs whether live Firebase auth is configured at all, not test-bypass intent) prevents that
  variable from being present in a production deploy - a stray `IS_E2E=1` left in a hosting platform's
  environment config, a misconfigured preview/staging env promoted to prod, or any process that
  inherits it would cause `authBypass` to evaluate `true` in production. That skips ID-token
  verification AND the `businessMembers` membership check entirely, letting an unauthenticated caller
  mint a live "Boss Report" share token (and, in the sibling `import-mapping` route protected by the
  identical pattern, read/write another tenant's import-mapping record) for ANY `businessId` they
  supply in the request body, with no proof they belong to that tenant - a full cross-tenant
  authorization bypass gated on nothing but one accidental env var.
- Fix commit: c6a711e fix(security): harden import-mapping + share auth bypass via isAuthBypassEnabled (P4 ultra-review Critical; closes P3 F5)
- Key evidence: `const authBypass = process.env.IS_E2E === "1" || !isLiveAuth();` is replaced with
  `const authBypass = isAuthBypassEnabled() || !isLiveAuth();`, importing a helper
  (`@/services/auth/authBypass`) that already existed in the codebase pre-fix and whose body is:
  `if (process.env.NODE_ENV === "production") return false;` before it reads `IS_E2E` at all (in test)
  or a separate `NEXT_PUBLIC_E2E_AUTH_BYPASS` flag (in dev/browser context) - i.e. the safe helper
  short-circuits to `false` in production BEFORE consulting any flag, which the raw `IS_E2E` read in
  this route did not. The identical pattern was fixed in `src/app/api/import-mapping/route.ts` in the
  same commit.
- Scoring: HIT if the subject identifies that gating the auth bypass on a raw `process.env.IS_E2E ===
  "1"` check (rather than a NODE_ENV-scoped/production-safe guard) means a stray or misconfigured
  environment variable in production could skip authentication and the tenant-membership check
  entirely, and states the consequence: an unauthenticated caller could mint a share token / access
  another business's data for any `businessId` they choose to send. PARTIAL if the subject flags
  `IS_E2E` as an env-var-driven bypass that looks risky or "should not exist in production code" but
  doesn't articulate that the missing piece is specifically NODE_ENV-scoping (not the mere existence of
  a test bypass, which is legitimate and documented). Plausible-but-wrong findings: (1) claiming
  `isLiveAuth()` itself is the vulnerable check (it only reports whether Firebase live auth is
  configured; it is not the test/demo bypass and is not the defect); (2) flagging the 32KB
  content-length + body-size double-check as redundant/buggy (intentional defense-in-depth: header can
  lie, so the actual byte length is also checked); (3) claiming `authConfigurationError`'s regex is a
  security leak because it echoes internal error text (the function only returns a boolean used to pick
  a generic 503 message; the regex is never echoed to the client, so this is not the real defect here).
