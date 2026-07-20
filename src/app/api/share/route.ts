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
