import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS } from "@/services/db/types";
import { accessLevelServer } from "@/services/security/roleAccess";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// Task 3 (owner step 3): platform-owner-only listing of reviewable catalogEntries for human approval.
// GET only - lists TWO reviewable shapes from the top-level (shared, cross-tenant) `catalogEntries`
// collection, paginated: legacy verificationStatus "pending" docs AND ladder-written docs
// (verificationStatus "verified" + provenanceTier "ladder_verified_strong" - masterAppend.ts never
// writes "pending", so a pending-only query left this queue permanently empty). Each entry carries
// pendingKind ("pending" | "ladder_verified") so the client can tell them apart. human_verified and
// rejected docs never appear. Approve/reject live in ./[id]/route.ts (POST). Auth pattern
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

    // Firestore has no OR across the two reviewable shapes' different field pairs, so each branch
    // runs one query per shape (pending / ladder-written) and merges, tagging pendingKind.
    const tag = (
      docs: FirebaseFirestore.QueryDocumentSnapshot[],
      pendingKind: "pending" | "ladder_verified",
    ) => docs.map((d) => ({ id: d.id, ...d.data(), pendingKind }));

    // A barcode search is a targeted point lookup: normalizedBarcode is the primary key convention
    // (masterAppend.ts), so match on it directly rather than trying to paginate a filtered query.
    if (barcodeSearch) {
      const base = db
        .collection(COLLECTIONS.catalogEntries)
        .where("normalizedBarcode", "==", barcodeSearch);
      const [pendingSnap, ladderSnap] = await Promise.all([
        base.where("verificationStatus", "==", "pending").limit(pageSize).get(),
        base
          .where("verificationStatus", "==", "verified")
          .where("provenanceTier", "==", "ladder_verified_strong")
          .limit(pageSize)
          .get(),
      ]);
      const entries = [...tag(pendingSnap.docs, "pending"), ...tag(ladderSnap.docs, "ladder_verified")].slice(0, pageSize);
      return json({ entries, nextCursor: null });
    }

    // Legacy pending docs carry firstSeenAt; ladder-written docs are stamped updatedAt by
    // masterAppend.ts (never firstSeenAt), so each query orders by the field its docs actually have
    // and the merge sorts on whichever is present, newest first.
    let pendingQuery = db
      .collection(COLLECTIONS.catalogEntries)
      .where("verificationStatus", "==", "pending")
      .orderBy("firstSeenAt", "desc")
      .limit(pageSize + 1);
    let ladderQuery = db
      .collection(COLLECTIONS.catalogEntries)
      .where("verificationStatus", "==", "verified")
      .where("provenanceTier", "==", "ladder_verified_strong")
      .orderBy("updatedAt", "desc")
      .limit(pageSize + 1);

    if (cursor) {
      const cursorSnap = await db.collection(COLLECTIONS.catalogEntries).doc(cursor).get();
      if (cursorSnap.exists) {
        pendingQuery = pendingQuery.startAfter(cursorSnap);
        ladderQuery = ladderQuery.startAfter(cursorSnap);
      }
    }

    const [pendingSnap, ladderSnap] = await Promise.all([pendingQuery.get(), ladderQuery.get()]);
    const timestampOf = (e: Record<string, unknown>): string => {
      const t = e.firstSeenAt ?? e.updatedAt;
      return typeof t === "string" ? t : "";
    };
    const merged = [...tag(pendingSnap.docs, "pending"), ...tag(ladderSnap.docs, "ladder_verified")]
      .sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
    const entries = merged.slice(0, pageSize);
    const hasMore = merged.length > pageSize;
    const nextCursor = hasMore ? entries[entries.length - 1]?.id ?? null : null;

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
