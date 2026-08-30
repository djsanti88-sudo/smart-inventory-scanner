import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  mintShareToken,
  normalizeBossReportSnapshot,
} from "@/server/share/shareTokenStore";
import { buildBossReport } from "@/reports/variance/bossReport";
import { getAdminAuth, getAdminDb } from "@/sync-database/cloud/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/sync-database/types";
import { isLiveAuth } from "@/authentication/service/authMode";
import { isAuthBypassEnabled } from "@/authentication/service/authBypass";
import { logServerEvent } from "@/decoding/server/log";

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
// membership before minting. The credential-free demo paths are mock mode or the hardened
// isAuthBypassEnabled gate, which is false in production before any flag is read (a stray IS_E2E in
// production can never open this).
export async function POST(request: NextRequest) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SHARE_SNAPSHOT_BYTES) {
    logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "snapshot_too_large", status: 413 });
    return json({ error: "Report snapshot must be 32KB or smaller." }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "invalid_body", status: 400 });
    return json({ error: "Invalid request body." }, 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_SHARE_SNAPSHOT_BYTES) {
    logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "snapshot_too_large", status: 413 });
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
    logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "invalid_body", status: 400 });
    return json({ error: "Invalid request body." }, 400);
  }

  const sessionId = stringField(body.sessionId);
  if (!sessionId) {
    logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "missing_session", status: 400 });
    return json({ error: "A session is required before creating a shareable link." }, 400);
  }

  const requestedBusinessId = stringField(body.businessId);
  const authBypass = isAuthBypassEnabled() || !isLiveAuth();
  if (!authBypass) {
    const idToken = stringField(body.idToken);
    if (!idToken) {
      logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "unauthenticated", status: 401 });
      return json({ error: "Sign in required." }, 401);
    }
    if (!requestedBusinessId) {
      logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "no_business", status: 400 });
      return json({ error: "Missing businessId." }, 400);
    }

    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (error) {
      if (authConfigurationError(error)) {
        logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "auth_unavailable", status: 503 });
        return json({ error: "Server auth is not configured." }, 503);
      }
      logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "bad_token", status: 401 });
      return json({ error: "Invalid or expired sign-in." }, 401);
    }

    try {
      const member = await getAdminDb()
        .doc(`${COLLECTIONS.businessMembers}/${memberDocId(requestedBusinessId, uid)}`)
        .get();
      if (!member.exists) {
        logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "not_member", businessId: requestedBusinessId, status: 403 });
        return json({ error: "Not a member of this business." }, 403);
      }
    } catch (error) {
      if (authConfigurationError(error)) {
        logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "auth_unavailable", businessId: requestedBusinessId, status: 503 });
        return json({ error: "Server auth is not configured." }, 503);
      }
      logServerEvent({ route: "/api/share", event: "mint_failed", reasonCode: "membership_check_failed", businessId: requestedBusinessId, status: 503 });
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
  let token: string;
  try {
    token = await mintShareToken({
      businessId,
      sessionId,
      reportSnapshot,
      createdAt: now,
      expiresAt: now + SHARE_TTL_MS,
    });
  } catch (error) {
    // mintShareToken only throws when durable storage is required (production) and unavailable.
    // Fail loud here too: no token, no url, so the caller never gets a link that will 404 later.
    logServerEvent({
      route: "/api/share",
      event: "mint_failed",
      reasonCode: "durable_storage_unavailable",
      status: 503,
    });
    console.error(
      "[api/share] mintShareToken failed:",
      error instanceof Error ? error.message : String(error),
    );
    return json({ error: "Could not create a shareable link right now." }, 503);
  }

  return json({ token, url: `${request.nextUrl.origin}/report/${token}` });
}
