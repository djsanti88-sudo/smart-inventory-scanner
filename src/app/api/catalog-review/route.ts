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

// Pagination cursor: the two queue queries order by DIFFERENT fields (pending -> firstSeenAt,
// ladder -> updatedAt) and any given doc carries only one of them, so a single shared cursor doc
// snapshot cross-applied to both queries would make the Admin SDK throw ("Field ... is missing in
// the provided DocumentSnapshot"). Each stream therefore keeps its OWN cursor doc id, packed into
// one opaque base64url token; each is applied only to its own query. A malformed token is treated
// as the first page (never an error).
type MergedCursor = { p?: string; l?: string };

function encodeCursor(cursor: MergedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): MergedCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object") {
      const { p, l } = parsed as Record<string, unknown>;
      const cursor: MergedCursor = {
        ...(typeof p === "string" && p ? { p } : {}),
        ...(typeof l === "string" && l ? { l } : {}),
      };
      if (cursor.p || cursor.l) return cursor;
    }
  } catch {
    // Malformed cursor - fall through to first page.
  }
  return null;
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
      .orderBy("firstSeenAt", "desc");
    let ladderQuery = db
      .collection(COLLECTIONS.catalogEntries)
      .where("verificationStatus", "==", "verified")
      .where("provenanceTier", "==", "ladder_verified_strong")
      .orderBy("updatedAt", "desc");

    // Per-stream cursors (see MergedCursor above): each stream resumes after its OWN last-emitted
    // doc - never the other stream's, whose snapshot would be missing this query's orderBy field.
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      const collection = db.collection(COLLECTIONS.catalogEntries);
      const [pendingCursorSnap, ladderCursorSnap] = await Promise.all([
        decodedCursor.p ? collection.doc(decodedCursor.p).get() : Promise.resolve(null),
        decodedCursor.l ? collection.doc(decodedCursor.l).get() : Promise.resolve(null),
      ]);
      if (pendingCursorSnap?.exists) pendingQuery = pendingQuery.startAfter(pendingCursorSnap);
      if (ladderCursorSnap?.exists) ladderQuery = ladderQuery.startAfter(ladderCursorSnap);
    }

    // The two shapes' queries need different composite indexes (declared in firestore.indexes.json);
    // a missing index rejects with FAILED_PRECONDITION on real Firestore. Settle each independently
    // so one shape failing degrades to an empty page for that shape (logged) instead of 500ing the
    // whole listing - only both failing leaves nothing to serve and falls through to the catch.
    const [pendingResult, ladderResult] = await Promise.allSettled([
      pendingQuery.limit(pageSize + 1).get(),
      ladderQuery.limit(pageSize + 1).get(),
    ]);
    if (pendingResult.status === "rejected" && ladderResult.status === "rejected") {
      throw pendingResult.reason;
    }
    if (pendingResult.status === "rejected") {
      logServerEvent({ route: "/api/catalog-review", event: "read_degraded", reasonCode: "pending_query_failed", status: 200 });
    }
    if (ladderResult.status === "rejected") {
      logServerEvent({ route: "/api/catalog-review", event: "read_degraded", reasonCode: "ladder_query_failed", status: 200 });
    }
    const pendingDocs = pendingResult.status === "fulfilled" ? pendingResult.value.docs : [];
    const ladderDocs = ladderResult.status === "fulfilled" ? ladderResult.value.docs : [];
    const timestampOf = (e: Record<string, unknown>): string => {
      const t = e.firstSeenAt ?? e.updatedAt;
      return typeof t === "string" ? t : "";
    };
    const merged = [...tag(pendingDocs, "pending"), ...tag(ladderDocs, "ladder_verified")]
      .sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
    const entries = merged.slice(0, pageSize);
    const hasMore = merged.length > pageSize;
    // A stream that emitted nothing on this page carries its incoming cursor forward, so entries
    // sliced off the merged page are never skipped and never re-emitted.
    let nextCursor: string | null = null;
    if (hasMore) {
      const lastEmittedOf = (kind: "pending" | "ladder_verified"): string | undefined =>
        [...entries].reverse().find((e) => e.pendingKind === kind)?.id;
      nextCursor = encodeCursor({
        p: lastEmittedOf("pending") ?? decodedCursor?.p,
        l: lastEmittedOf("ladder_verified") ?? decodedCursor?.l,
      });
    }

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
