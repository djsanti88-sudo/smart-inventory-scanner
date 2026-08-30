import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { accessLevelServer } from "@/users-businesses/roles/roleAccess";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { canonicalGtin } from "@/services/upc/gtin";
import { checkRateLimit, intEnv } from "@/services/security/aiSpendGuard";
import { decodeStorage } from "@/server/decode/storage";
import { disputeCatalogEntry } from "@/server/catalog/catalogDispute";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// Catalog revocation round (owner-approved design, section 2.2). A shop reports that a scanned
// identity from the shared `catalogEntries` master catalog was wrong. Auth is DELIBERATELY looser
// than /api/catalog-review (platformOwner-only): catalogEntries carries no businessId, so
// membership-in-a-specific-business isn't a meaningful check on the DOC being disputed - any
// authenticated caller (accessLevelServer "business" OR "platform") may dispute a catalog entry.
// The abuse ceiling is the threshold/dedup logic inside disputeCatalogEntry (catalogDispute.ts),
// not tighter auth on the doc.
//
// BUT the businessId in the request body IS meaningful: it is the attribution key
// disputeCatalogEntry dedupes on and the identity behind the "3 distinct businesses" demotion
// threshold for human_verified entries. Without verifying the caller's uid is actually a member of
// that businessId, one authenticated account could submit unlimited fabricated businessId strings
// and fake "3 distinct businesses" alone - mirrors resolve-scan's membership check (403
// "not_member"). platformOwner is exempt (may act on behalf of any business), same as resolve-scan.
//
// Unlike masterAppend's fire-and-forget append, a dispute is a deliberate user action: a genuine
// Firestore failure surfaces to the caller as a real error response (500), never silently
// swallowed to a fake success, so the shop knows their report didn't land.

interface DisputeBody {
  idToken?: unknown;
  normalizedBarcode?: unknown;
  businessId?: unknown;
  reason?: unknown;
}

const MAX_BUSINESS_ID_LENGTH = 128;
const MAX_NORMALIZED_BARCODE_LENGTH = 64;
const MAX_REASON_LENGTH = 2000;
const CATALOG_DISPUTE_RATE_LIMIT = 120;

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
        headers: { ...statusOrInit.headers, "Cache-Control": "no-store" },
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

export async function POST(request: NextRequest) {
  const ip = ipFromRequest(request);
  try {
    // Route-family key prefix (matches ai-lookup GET's "GET:${ip}" / export's "EXPORT:${ip}"
    // convention): without it this shared a raw-IP bucket with every other route calling
    // checkRateLimit(ip, ...), so a burst on one route could 429 an unrelated route for the same
    // client IP even though each route configures its own distinct rate-limit env var.
    const rl = await checkRateLimit(`CATALOG_DISPUTE:${ip}`, {
      limit: intEnv(process.env.CATALOG_DISPUTE_RATE_LIMIT, CATALOG_DISPUTE_RATE_LIMIT),
      storage: await decodeStorage(),
    });
    if (!rl.allowed) {
      logServerEvent({ route: "/api/catalog-dispute", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
      return json(
        { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  } catch {
    logServerEvent({ route: "/api/catalog-dispute", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
  }

  let body: DisputeBody;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body shape");
    }
    body = parsed as DisputeBody;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const idToken = stringField(body.idToken);
  const normalizedBarcode = stringField(body.normalizedBarcode);
  const businessId = stringField(body.businessId);
  // Reason is untrusted user text (semantic firewall) - passed through as a plain string;
  // disputeCatalogEntry itself caps its length before it ever reaches Firestore.
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  if (businessId.length > MAX_BUSINESS_ID_LENGTH) {
    return json({ error: "businessId is too long." }, 400);
  }
  if (normalizedBarcode.length > MAX_NORMALIZED_BARCODE_LENGTH) {
    return json({ error: "normalizedBarcode is too long." }, 400);
  }
  if (typeof reason === "string" && reason.length > MAX_REASON_LENGTH) {
    return json({ error: "reason is too long." }, 400);
  }

  if (!normalizedBarcode) {
    return json({ error: "Missing normalizedBarcode." }, 400);
  }
  if (!businessId) {
    return json({ error: "Missing businessId." }, 400);
  }

  if (!idToken) {
    logServerEvent({ route: "/api/catalog-dispute", event: "auth_reject", reasonCode: "missing_token", status: 401 });
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
      logServerEvent({ route: "/api/catalog-dispute", event: "auth_unavailable", reasonCode: "server_auth_unavailable", status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/catalog-dispute", event: "auth_reject", reasonCode: "bad_token", status: 401 });
    return json({ error: "Invalid or expired sign-in." }, 401);
  }

  // Any authenticated user may dispute the catalog DOC (accessLevelServer is "business" or
  // "platform" - both allowed). This intentionally never gates on accessLevelServer for the doc
  // itself, unlike catalog-review's platform-only check - see the module comment above for why.
  const level = accessLevelServer({ uid, email });

  // Membership check on the CLAIMED businessId (not on the doc): platformOwner may attribute a
  // dispute to any business; a business-level caller must actually be a member of the businessId
  // they claim, or the "3 distinct businesses" abuse ceiling in disputeCatalogEntry is spoofable
  // from a single account. Mirrors resolve-scan's identical check.
  if (level !== "platform") {
    try {
      const db = getAdminDb();
      const member = await db.doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`).get();
      if (!member.exists) {
        logServerEvent({ route: "/api/catalog-dispute", event: "auth_reject", reasonCode: "not_member", businessId, status: 403 });
        return json({ error: "Not a member of this business" }, 403);
      }
    } catch (error) {
      if (authConfigurationError(error)) {
        logServerEvent({ route: "/api/catalog-dispute", event: "auth_unavailable", reasonCode: "server_auth_unavailable", status: 503 });
        return json({ error: "Server auth is not configured." }, 503);
      }
      logServerEvent({ route: "/api/catalog-dispute", event: "write_failed", reasonCode: "member_read_error", businessId, status: 500 });
      return json({ error: "Failed to verify business membership." }, 500);
    }
  }

  const canonical = canonicalGtin(normalizedBarcode);
  if (!canonical) {
    return json({ error: "normalizedBarcode is not a recognizable GTIN/UPC/EAN shape." }, 400);
  }

  const result = await disputeCatalogEntry({ canonical, businessId, reason });

  if (!result.ok) {
    if (result.reason === "not_found") {
      logServerEvent({ route: "/api/catalog-dispute", event: "not_found", status: 404 });
      return json({ error: "Catalog entry not found." }, 404);
    }
    logServerEvent({ route: "/api/catalog-dispute", event: "write_failed", reasonCode: "write_error", status: 500 });
    return json({ error: "Failed to record the dispute." }, 500);
  }

  logServerEvent({ route: "/api/catalog-dispute", event: "disputed", status: 200 });
  return json({
    ok: true,
    disputeCount: result.disputeCount,
    changed: result.changed,
    ...(result.verificationStatus ? { verificationStatus: result.verificationStatus } : {}),
  });
}
