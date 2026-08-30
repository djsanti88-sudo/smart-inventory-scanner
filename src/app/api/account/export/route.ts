import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/authentication/service/authMode";
import { isAuthBypassEnabled } from "@/authentication/service/authBypass";
import { intEnv, checkRateLimit } from "@/decoding/limits/aiSpendGuard";
import { decodeStorage } from "@/server/decode/storage";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// D1 (Phase 6): full-account data export. Auth pattern mirrors src/app/api/share/route.ts:80-111
// (verify Firebase ID token + business membership before touching any tenant data). On success,
// walks every tenant-scoped Firestore collection for the caller's businessId and returns ONE JSON
// bundle. Deliberately EXCLUDES master/shared collections (catalogEntries) - those are the shared
// corpus, never a single tenant's data (CLAUDE.md invariant re: catalogEntries).
//
// Scope note: JSON bundle only. CSV-per-collection (csvExport.ts builders) was considered but
// skipped for this task - those builders are shaped around in-memory Zustand session state, not raw
// Firestore documents, and reusing them here would couple this server route to client-side store
// shapes. A CSV projection can be layered on top of this JSON bundle later without re-deriving the
// tenant walk.

type ExportRequestBody = {
  businessId?: unknown;
  idToken?: unknown;
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

// Tenant-scoped subcollections that live at businesses/{businessId}/{collection} per
// repositories.ts:42-43. Deliberately excludes COLLECTIONS.businesses (the parent doc itself is
// handled separately), COLLECTIONS.userProfiles / businessMembers (top-level, handled separately
// below, filtered to this business/user), and COLLECTIONS.catalogEntries (shared master corpus -
// never a single tenant's export).
const TENANT_SUBCOLLECTIONS: readonly string[] = [
  COLLECTIONS.products,
  COLLECTIONS.aliases,
  COLLECTIONS.countSessions,
  COLLECTIONS.inventoryCounts,
  COLLECTIONS.scanEvents,
  COLLECTIONS.unknownCodeReviews,
  COLLECTIONS.settings,
  COLLECTIONS.shopOverrides,
  COLLECTIONS.auditLog,
];

type CollectionResult = {
  count: number;
  truncated: boolean;
  docs: Record<string, unknown>[];
};

async function exportCollection(
  businessId: string,
  name: string,
  maxDocs: number,
): Promise<CollectionResult> {
  const snap = await getAdminDb()
    .collection(`${COLLECTIONS.businesses}/${businessId}/${name}`)
    .limit(maxDocs + 1)
    .get();
  // id must come AFTER the spread of d.data() so the authoritative
  // Firestore doc id always wins over a same-named "id" field that might exist inside the stored
  // document payload (spread order previously let payload.id silently overwrite the true doc id).
  const docs = snap.docs.slice(0, maxDocs).map((d) => ({ ...d.data(), id: d.id }));
  return {
    count: docs.length,
    truncated: snap.docs.length > maxDocs,
    docs,
  };
}

export async function POST(request: NextRequest) {
  let body: ExportRequestBody;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body shape");
    }
    body = parsed as ExportRequestBody;
  } catch {
    logServerEvent({ route: "/api/account/export", event: "error", reasonCode: "invalid_body", status: 400 });
    return json({ error: "Invalid request body." }, 400);
  }

  const requestedBusinessId = stringField(body.businessId);
  const authBypass = isAuthBypassEnabled() || !isLiveAuth();

  // Fix 1 (P6 ultra-review): export MIRRORS the sibling delete route's bypass refusal
  // (src/app/api/account/delete/route.ts:83-85) rather than pinning to a demo-tenant bundle. A full
  // account export is bulk tenant data egress; serving it to ANY anonymous caller in mock mode (the
  // deployed default) is an unthrottled data-egress hole. Nothing in the UI calls this route yet
  // (D1 shipped the route only), so refusing outright loses no functionality.
  if (authBypass) {
    logServerEvent({ route: "/api/account/export", event: "auth_reject", reasonCode: "auth_bypass_refused", status: 403 });
    return json({ error: "Account export requires a signed-in member." }, 403);
  }

  let uid: string | null = null;

  // authBypass is always false past this point (refused above), so this block always runs -
  // kept as an explicit block (not merged into the outer function body) to minimize the diff
  // against the original if/authBypass structure.
  {
    const idToken = stringField(body.idToken);
    if (!idToken) {
      logServerEvent({ route: "/api/account/export", event: "auth_reject", reasonCode: "unauthenticated", status: 401 });
      return json({ error: "Sign in required." }, 401);
    }
    if (!requestedBusinessId) {
      logServerEvent({ route: "/api/account/export", event: "auth_reject", reasonCode: "no_business", status: 400 });
      return json({ error: "Missing businessId." }, 400);
    }

    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch (error) {
      if (authConfigurationError(error)) {
        logServerEvent({ route: "/api/account/export", event: "auth_unavailable", reasonCode: "auth_unavailable", status: 503 });
        return json({ error: "Server auth is not configured." }, 503);
      }
      logServerEvent({ route: "/api/account/export", event: "auth_reject", reasonCode: "bad_token", status: 401 });
      return json({ error: "Invalid or expired sign-in." }, 401);
    }

    try {
      const member = await getAdminDb()
        .doc(`${COLLECTIONS.businessMembers}/${memberDocId(requestedBusinessId, uid)}`)
        .get();
      if (!member.exists) {
        // Honest-reason 403 without leaking whether requestedBusinessId even exists.
        logServerEvent({ route: "/api/account/export", event: "auth_reject", reasonCode: "not_member", businessId: requestedBusinessId, status: 403 });
        return json({ error: "Not a member of this business." }, 403);
      }
      // F-04 (2026-07-29 audit fix): a full account export includes role-restricted collections
      // (e.g. auditLog, per firestore.rules ~:457-462 which limits auditLog reads to owner/admin).
      // The Admin SDK bypasses Firestore rules entirely, so this route must enforce the same
      // owner/admin-only policy itself. Membership alone is NOT sufficient - viewer/counter get an
      // exact 403 for the WHOLE export, before any collection is read.
      const role = member.data()?.role;
      if (role !== "owner" && role !== "admin") {
        logServerEvent({ route: "/api/account/export", event: "auth_reject", reasonCode: "insufficient_role", businessId: requestedBusinessId, status: 403 });
        return json({ error: "Account export requires an owner or admin role." }, 403);
      }
    } catch (error) {
      if (authConfigurationError(error)) {
        logServerEvent({ route: "/api/account/export", event: "auth_unavailable", reasonCode: "auth_unavailable", businessId: requestedBusinessId, status: 503 });
        return json({ error: "Server auth is not configured." }, 503);
      }
      logServerEvent({ route: "/api/account/export", event: "error", reasonCode: "membership_check_failed", businessId: requestedBusinessId, status: 503 });
      return json({ error: "Could not verify business membership." }, 503);
    }
  }

  // A durable limiter key may only use verified, bounded identities. Client-controlled forwarding
  // headers are deliberately excluded: they are spoofable and each novel value otherwise grows
  // ladder_kv indefinitely. Rate limiting happens after token, membership, and role validation so
  // rejected requests never consume a member's export bucket.
  try {
    const rl = await checkRateLimit(`EXPORT:${requestedBusinessId}:${uid}`, {
      limit: intEnv(process.env.ACCOUNT_EXPORT_RATE_LIMIT, 10),
      windowMs: intEnv(process.env.ACCOUNT_EXPORT_RATE_WINDOW_MS, 60_000),
      storage: await decodeStorage(),
      failClosedOnStorageError: true,
    });
    if (!rl.allowed) {
      logServerEvent({ route: "/api/account/export", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
      return NextResponse.json(
        { error: "Too many export requests. Slow down and try again.", retryAfterMs: rl.retryAfterMs },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  } catch {
    logServerEvent({ route: "/api/account/export", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 503 });
    return json({ error: "Rate limiting is temporarily unavailable. Try again shortly." }, 503);
  }

  // Fix 1: the prior demo-tenant pin for authBypass mode is dead code now that authBypass is
  // refused outright above - only a verified live member ever reaches this point, so
  // requestedBusinessId is always the caller's own verified business.
  const businessId = requestedBusinessId;
  const maxDocs = intEnv(process.env.ACCOUNT_EXPORT_MAX_DOCS, 50000);

  const collections: Record<string, { count: number; truncated: boolean; docs: unknown[] }> = {};

  try {
    for (const name of TENANT_SUBCOLLECTIONS) {
      collections[name] = await exportCollection(businessId, name, maxDocs);
    }

    // businesses/{businessId} root doc itself.
    const businessDoc = await getAdminDb().doc(`${COLLECTIONS.businesses}/${businessId}`).get();
    collections[COLLECTIONS.businesses] = {
      count: businessDoc.exists ? 1 : 0,
      truncated: false,
      docs: businessDoc.exists ? [{ ...businessDoc.data(), id: businessDoc.id }] : [],
    };

    // businessMembers: top-level collection, filtered to this business only.
    const membersSnap = await getAdminDb()
      .collection(COLLECTIONS.businessMembers)
      .where("businessId", "==", businessId)
      .limit(maxDocs + 1)
      .get();
    const memberDocs = membersSnap.docs.slice(0, maxDocs).map((d) => ({ ...d.data(), id: d.id }));
    collections[COLLECTIONS.businessMembers] = {
      count: memberDocs.length,
      truncated: membersSnap.docs.length > maxDocs,
      docs: memberDocs,
    };

    // userProfiles: top-level collection. Filtered to the caller's own profile only (never another
    // member's profile) - in authBypass/demo mode there is no uid, so this section is omitted.
    if (uid) {
      const profileDoc = await getAdminDb().doc(`${COLLECTIONS.userProfiles}/${uid}`).get();
      collections[COLLECTIONS.userProfiles] = {
        count: profileDoc.exists ? 1 : 0,
        truncated: false,
        docs: profileDoc.exists ? [{ ...profileDoc.data(), id: profileDoc.id }] : [],
      };
    }
  } catch (error) {
    if (authConfigurationError(error)) {
      logServerEvent({ route: "/api/account/export", event: "auth_unavailable", reasonCode: "auth_unavailable", businessId, status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/account/export", event: "export_failed", reasonCode: "tenant_read_error", businessId, status: 500 });
    return json({ error: "Export failed while reading tenant data." }, 500);
  }

  return json({
    exportedAt: new Date().toISOString(),
    businessId,
    collections,
  });
}
