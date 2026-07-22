import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS } from "@/services/db/types";
import { accessLevelServer } from "@/services/security/roleAccess";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// Task 3 (owner step 3): platform-owner-only listing of pending catalogEntries for human approval.
// GET only - lists verificationStatus "pending" docs from the top-level (shared, cross-tenant)
// `catalogEntries` collection, paginated. Approve/reject live in ./[id]/route.ts (POST). Auth pattern
// mirrors src/app/api/resolve-scan/route.ts: verify the Firebase ID token, then require platformOwner
// (accessLevelServer === "platform") - a customer/business caller is refused with 403, never a partial
// or sanitized view (this collection is never tenant data, so there is no lesser view to fall back to).

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

function bearerToken(request: NextRequest): string {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

export async function GET(request: NextRequest) {
  const idToken = bearerToken(request);
  if (!idToken) {
    logServerEvent({ route: "/api/catalog-review", event: "auth_reject", reasonCode: "missing_token", status: 401 });
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
      logServerEvent({ route: "/api/catalog-review", event: "auth_unavailable", reasonCode: "server_auth_unavailable", status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/catalog-review", event: "auth_reject", reasonCode: "bad_token", status: 401 });
    return json({ error: "Invalid or expired sign-in." }, 401);
  }

  const level = accessLevelServer({ uid, email });
  if (level !== "platform") {
    logServerEvent({ route: "/api/catalog-review", event: "auth_reject", reasonCode: "not_platform_owner", status: 403 });
    return json({ error: "Platform owner access required." }, 403);
  }

  const { searchParams } = new URL(request.url);
  const pageSizeParam = Number.parseInt(searchParams.get("pageSize") ?? "", 10);
  const pageSize = Number.isFinite(pageSizeParam) && pageSizeParam > 0
    ? Math.min(pageSizeParam, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const cursor = (searchParams.get("cursor") ?? "").trim();
  const barcodeSearch = (searchParams.get("barcode") ?? "").trim();

  try {
    const db = getAdminDb();

    // A barcode search is a targeted point lookup: normalizedBarcode is the primary key convention
    // (masterAppend.ts), so match on it directly rather than trying to paginate a filtered query.
    if (barcodeSearch) {
      const snap = await db
        .collection(COLLECTIONS.catalogEntries)
        .where("normalizedBarcode", "==", barcodeSearch)
        .where("verificationStatus", "==", "pending")
        .limit(pageSize)
        .get();
      const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return json({ entries, nextCursor: null });
    }

    let query = db
      .collection(COLLECTIONS.catalogEntries)
      .where("verificationStatus", "==", "pending")
      .orderBy("firstSeenAt", "desc")
      .limit(pageSize + 1);

    if (cursor) {
      const cursorSnap = await db.collection(COLLECTIONS.catalogEntries).doc(cursor).get();
      if (cursorSnap.exists) {
        query = query.startAfter(cursorSnap);
      }
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const entries = docs.map((d) => ({ id: d.id, ...d.data() }));
    const hasMore = snap.docs.length > pageSize;
    const nextCursor = hasMore ? docs[docs.length - 1]?.id ?? null : null;

    return json({ entries, nextCursor });
  } catch (error) {
    if (authConfigurationError(error)) {
      logServerEvent({ route: "/api/catalog-review", event: "read_unavailable", reasonCode: "server_auth_unavailable", status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/catalog-review", event: "read_failed", reasonCode: "read_error", status: 500 });
    return json({ error: "Failed to load pending catalog entries." }, 500);
  }
}
