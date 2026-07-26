import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebaseAdmin";
import { accessLevelServer } from "@/services/security/roleAccess";
import { canonicalGtin } from "@/services/upc/gtin";
import { disputeCatalogEntry } from "@/server/catalog/catalogDispute";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// Catalog revocation round (owner-approved design, section 2.2). A shop reports that a scanned
// identity from the shared `catalogEntries` master catalog was wrong. Auth is DELIBERATELY looser
// than /api/catalog-review (platformOwner-only): catalogEntries carries no businessId, so
// membership-in-a-specific-business isn't a meaningful check here - any authenticated caller
// (accessLevelServer "business" OR "platform") may dispute. The abuse ceiling is the
// threshold/dedup logic inside disputeCatalogEntry (catalogDispute.ts), not tighter auth.
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

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
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

  // Any authenticated user may dispute (accessLevelServer is "business" or "platform" - both
  // allowed). This intentionally never gates on accessLevelServer at all, unlike catalog-review's
  // platform-only check - see the module comment above for why.
  void accessLevelServer({ uid, email });

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
