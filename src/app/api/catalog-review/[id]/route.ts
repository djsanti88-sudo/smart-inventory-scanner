import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS } from "@/services/db/types";
import { accessLevelServer } from "@/services/security/roleAccess";
import { checkRateLimit, intEnv } from "@/services/security/aiSpendGuard";
import { ladderStorage } from "@/server/upc/storage";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// Task 3 (owner step 3): Approve/Reject a pending catalogEntries doc. platformOwner-only (same auth
// pattern as ../route.ts). Approve -> verificationStatus "verified", provenanceTier "human_verified",
// verifiedBy set to the caller's identity, auditLog appended. Reject -> verificationStatus "rejected",
// timesRejected incremented, auditLog appended. Both mutations run against the top-level (shared,
// cross-tenant) `catalogEntries` collection only - never a tenant subcollection.

type ReviewAction = "approve" | "reject";

const MAX_ENTRY_ID_LENGTH = 256;
const CATALOG_REVIEW_ID_RATE_LIMIT = 120;

interface ActionBody {
  idToken?: unknown;
  action?: unknown;
}

function ipFromRequest(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

function json(body: unknown, statusOrInit: number | ResponseInit = 200): NextResponse {
  const options = typeof statusOrInit === "number"
    ? { status: statusOrInit, headers: { "Cache-Control": "no-store" } }
    : {
        ...statusOrInit,
        headers: { ...(statusOrInit.headers as Record<string, string> | undefined), "Cache-Control": "no-store" },
      };
  return NextResponse.json(body, options);
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ip = ipFromRequest(request);
  try {
    const rl = await checkRateLimit(ip, {
      limit: intEnv(process.env.CATALOG_REVIEW_RATE_LIMIT, CATALOG_REVIEW_ID_RATE_LIMIT),
      storage: await ladderStorage(),
    });
    if (!rl.allowed) {
      logServerEvent({ route: "/api/catalog-review/[id]", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
      return json(
        { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  } catch {
    logServerEvent({ route: "/api/catalog-review/[id]", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
  }

  const { id } = await context.params;
  const entryId = stringField(id);
  if (entryId.length > MAX_ENTRY_ID_LENGTH) {
    return json({ error: "Catalog entry id is too long." }, 400);
  }
  if (!entryId) {
    return json({ error: "Missing catalog entry id." }, 400);
  }

  let body: ActionBody;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body shape");
    }
    body = parsed as ActionBody;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const idToken = stringField(body.idToken);
  const action = stringField(body.action) as ReviewAction | "";

  if (action !== "approve" && action !== "reject") {
    return json({ error: 'action must be "approve" or "reject".' }, 400);
  }

  if (!idToken) {
    logServerEvent({ route: "/api/catalog-review/[id]", event: "auth_reject", reasonCode: "missing_token", status: 401 });
    return json({ error: "Sign in required." }, 401);
  }

  let uid = "";
  let email: string | null = null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
    email = decoded.email ?? null;
  } catch (error) {
    if (authConfigurationError(error)) {
      logServerEvent({ route: "/api/catalog-review/[id]", event: "auth_unavailable", reasonCode: "server_auth_unavailable", status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/catalog-review/[id]", event: "auth_reject", reasonCode: "bad_token", status: 401 });
    return json({ error: "Invalid or expired sign-in." }, 401);
  }

  const level = accessLevelServer({ uid, email });
  if (level !== "platform") {
    logServerEvent({ route: "/api/catalog-review/[id]", event: "auth_reject", reasonCode: "not_platform_owner", status: 403 });
    return json({ error: "Platform owner access required." }, 403);
  }

  const verifiedBy = email || uid;
  const now = new Date().toISOString();

  try {
    const db = getAdminDb();
    const ref = db.collection(COLLECTIONS.catalogEntries).doc(entryId);

    const snap = await ref.get();
    if (!snap.exists) {
      return json({ error: "Catalog entry not found." }, 404);
    }

    const auditEntry = {
      at: now,
      action,
      by: verifiedBy,
    };

    if (action === "approve") {
      await ref.update({
        verificationStatus: "verified",
        provenanceTier: "human_verified",
        verifiedBy,
        updatedAt: now,
        auditLog: FieldValue.arrayUnion(auditEntry),
      });
      logServerEvent({ route: "/api/catalog-review/[id]", event: "approved", status: 200 });
      return json({ ok: true, id: entryId, verificationStatus: "verified" });
    }

    await ref.update({
      verificationStatus: "rejected",
      timesRejected: FieldValue.increment(1),
      updatedAt: now,
      auditLog: FieldValue.arrayUnion(auditEntry),
    });
    logServerEvent({ route: "/api/catalog-review/[id]", event: "rejected", status: 200 });
    return json({ ok: true, id: entryId, verificationStatus: "rejected" });
  } catch (error) {
    if (authConfigurationError(error)) {
      logServerEvent({ route: "/api/catalog-review/[id]", event: "write_unavailable", reasonCode: "server_auth_unavailable", status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/catalog-review/[id]", event: "write_failed", reasonCode: "write_error", status: 500 });
    return json({ error: "Failed to update the catalog entry." }, 500);
  }
}
