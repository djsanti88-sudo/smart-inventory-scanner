import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/services/auth/authMode";

export const runtime = "nodejs";

// D2 (Phase 6): hard account deletion. GC-E (docs/superpowers/plans/2026-07-20-phase6-sell-ready.md):
// purges ONLY businesses/{businessId}/* + that business's businessMembers rows; NEVER
// catalogEntries/retailCatalogEntries or any other tenant. Deliberately stricter than the export
// route (src/app/api/account/export/route.ts): deletion has NO authBypass/mock path at all - a
// counter/viewer can never delete the business, and demo/mock mode is refused outright rather than
// pinned to a demo tenant. Requires the caller's BusinessMember role to be "owner" and an exact typed
// confirmation phrase, both re-verified server-side on every request (no client-trusted flags).

const CONFIRM_PHRASE = "DELETE MY ACCOUNT";

type DeleteRequestBody = {
  businessId?: unknown;
  idToken?: unknown;
  confirmPhrase?: unknown;
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

// firebase-admin 14.x / @google-cloud/firestore support Firestore#recursiveDelete(ref) - a
// BulkWriter-backed delete of a document and every descendant in its subcollections. Verified against
// node_modules/@google-cloud/firestore/types/firestore.d.ts (recursiveDelete is a Firestore method).
// This is required: a plain doc.delete() does NOT cascade into subcollections, which would leave
// orphaned tenant data behind under businesses/{businessId}/{collection}/*.
async function recursiveDeleteBusiness(businessId: string): Promise<void> {
  const db = getAdminDb();
  const businessRef = db.doc(`${COLLECTIONS.businesses}/${businessId}`);
  await db.recursiveDelete(businessRef);
}

async function deleteBusinessMembers(businessId: string): Promise<number> {
  const db = getAdminDb();
  const snap = await db
    .collection(COLLECTIONS.businessMembers)
    .where("businessId", "==", businessId)
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  return snap.docs.length;
}

export async function POST(request: NextRequest) {
  let body: DeleteRequestBody;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body shape");
    }
    body = parsed as DeleteRequestBody;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  // Deletion is strictly live-auth, deliberately stricter than export's demo-tenant bypass pin.
  // There is no mock/demo deletion path at all - a demo tenant getting recursively deleted by a
  // stray test run or a misconfigured deploy is exactly the failure mode this refuses outright.
  // Mode read goes through isLiveAuth() (authMode.ts is the single source of truth, including the
  // legacy NEXT_PUBLIC_REQUIRE_LOGIN=1 back-compat path); IS_E2E stays a hard refuse on top.
  const authBypass = !isLiveAuth() || process.env.IS_E2E === "1";
  if (authBypass) {
    return json({ error: "Account deletion requires a signed-in owner." }, 403);
  }

  const businessId = stringField(body.businessId);
  const idToken = stringField(body.idToken);
  const confirmPhrase = stringField(body.confirmPhrase);

  if (!idToken) return json({ error: "Sign in required." }, 401);
  if (!businessId) return json({ error: "Missing businessId." }, 400);

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

  let memberRole: string | undefined;
  try {
    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`)
      .get();
    if (!member.exists) {
      // Honest-reason 403 without leaking whether businessId even exists.
      return json({ error: "Not a member of this business." }, 403);
    }
    const data = member.data() as { role?: unknown } | undefined;
    memberRole = typeof data?.role === "string" ? data.role : undefined;
  } catch (error) {
    if (authConfigurationError(error)) {
      return json({ error: "Server auth is not configured." }, 503);
    }
    return json({ error: "Could not verify business membership." }, 503);
  }

  // Only an "owner" may delete the business. A counter/viewer (or admin - deletion is more
  // destructive than day-to-day admin duties) must never be able to purge tenant data.
  if (memberRole !== "owner") {
    return json({ error: "Only the business owner can delete this account." }, 403);
  }

  // Confirmation phrase is checked AFTER role verification (never leak deletion capability via the
  // phrase-check response) but BEFORE any deletion runs. Exact match, case-sensitive, no trimming
  // beyond stringField's own trim - a fuzzy match here would be a footgun on an irreversible action.
  if (confirmPhrase !== CONFIRM_PHRASE) {
    return json({ error: `Type "${CONFIRM_PHRASE}" exactly to confirm deletion.` }, 400);
  }

  // Deletion runs the business tree FIRST, then the member rows - deliberately NOT reordered. If the
  // second step throws, the tree is gone but the member rows (including the owner's own membership)
  // survive, and this operation is SAFELY RETRYABLE: on a retry the surviving owner membership still
  // passes the role check, recursiveDelete of an already-gone tree is a no-op, and the member rows then
  // delete. So the error copy tells the caller to retry rather than implying an unrecoverable half-state.
  // (Deleting members first would orphan a live business with no owner if the tree delete then failed -
  // strictly worse, so the order stays.)
  try {
    await recursiveDeleteBusiness(businessId);
    await deleteBusinessMembers(businessId);
  } catch (error) {
    if (authConfigurationError(error)) {
      return json({ error: "Server auth is not configured." }, 503);
    }
    return json({ error: "Deletion partially completed. Retry to finish removing this account." }, 500);
  }

  // userProfiles is intentionally left untouched: a profile is per-user and may span multiple
  // businesses (a user can be a member of more than one business), so deleting THIS business gives
  // no reliable signal that the profile has zero remaining memberships without an additional
  // cross-business membership scan. Leaving it is the safe default; a future task can add that scan
  // if/when it is needed.
  return json({ deleted: true, businessId });
}
