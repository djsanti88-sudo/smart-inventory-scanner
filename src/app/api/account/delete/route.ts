import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/authentication/service/authMode";
import { intEnv } from "@/services/security/aiSpendGuard";
import { checkAccountDeleteRateLimit } from "@/services/security/accountDeleteRateLimit";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

// D2 (Phase 6): hard account deletion. GC-E (docs/archive/superpowers/plans/2026-07-20-phase6-sell-ready.md):
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

// firebase-admin surfaces a revoked session / disabled account from verifyIdToken(token, true) as
// `auth/id-token-revoked` (or `auth/user-disabled`), carried on the error's `code` and repeated in the
// message. Matched on both so a mocked/rethrown error shape still classifies correctly.
function revokedTokenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const text = `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : String(error)}`;
  return /id-token-revoked|session-cookie-revoked|user-disabled|token has been revoked/i.test(text);
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

// S2 (deep review 2026-08-09): the OWNER's own member row is deleted LAST, strictly after every other
// member row has deleted successfully. The owner row is this route's authorization anchor (the role
// check at the top reads exactly that document), so deleting it in the same concurrent Promise.all as
// the others made the advertised "Retry to finish" a LIE: if the owner's row won the race and another
// member's row failed, the retry hit "Not a member of this business." (403) and the residual member
// rows were stranded forever with no path to remove them. Deleting non-owner rows first and the owner
// row last means ANY partial failure leaves the authorization anchor intact, so the retry genuinely
// re-authorizes and finishes the job.
async function deleteBusinessMembers(businessId: string, ownerUid: string): Promise<number> {
  const db = getAdminDb();
  const snap = await db
    .collection(COLLECTIONS.businessMembers)
    .where("businessId", "==", businessId)
    .get();
  const ownerRowId = memberDocId(businessId, ownerUid);
  const ownerDocs = snap.docs.filter((d) => d.id === ownerRowId);
  const otherDocs = snap.docs.filter((d) => d.id !== ownerRowId);
  // Non-owner rows first, concurrently (unchanged throughput for the normal path).
  await Promise.all(otherDocs.map((d) => d.ref.delete()));
  // Owner row(s) last, only now that every other row is gone. A throw above never reaches this line.
  for (const d of ownerDocs) {
    await d.ref.delete();
  }
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
    // S1 (deep review 2026-08-09): checkRevoked = TRUE. Account deletion is irreversible, so a token
    // that was valid at issue time but whose session has since been revoked (owner signed out
    // everywhere, password reset, account disabled after a laptop theft) must NOT still be able to
    // purge the tenant. checkRevoked costs one extra Admin round-trip per call; that is trivially
    // affordable on a rare, irreversible, rate-limited action - unlike the /api/ai-lookup hot path.
    const decoded = await getAdminAuth().verifyIdToken(idToken, true);
    uid = decoded.uid;
  } catch (error) {
    if (authConfigurationError(error)) {
      return json({ error: "Server auth is not configured." }, 503);
    }
    if (revokedTokenError(error)) {
      // Honest copy: this is NOT a generic bad token - the session was deliberately ended.
      return json({ error: "This sign-in was revoked. Sign in again to delete this account." }, 401);
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

  // Rate limit AFTER role verification (rejected non-owners never consume the owner's bucket,
  // mirroring the export route) and BEFORE the phrase check (a phrase-guessing loop is exactly
  // the abuse this bounds). Durable Firestore-backed limiter (src/services/security/
  // accountDeleteRateLimit.ts) - deliberately NOT decode Turso storage, so this
  // GDPR/CCPA erasure path never 503s because an unrelated decode-cache DB is down or misconfigured.
  // It shares the SAME failure domain as the deletion itself (Firestore Admin SDK); verified
  // identities only in the key; fail CLOSED - if Firestore is down we refuse an irreversible action
  // rather than allow an unmetered one (and "limiter down" now means "deletion is impossible anyway").
  try {
    const rl = await checkAccountDeleteRateLimit(`DELETE:${businessId}:${uid}`, {
      limit: intEnv(process.env.ACCOUNT_DELETE_RATE_LIMIT, 3),
      windowMs: intEnv(process.env.ACCOUNT_DELETE_RATE_WINDOW_MS, 3_600_000),
    });
    if (!rl.allowed) {
      logServerEvent({ route: "/api/account/delete", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
      return NextResponse.json(
        { error: "Too many deletion attempts. Wait and try again.", retryAfterMs: rl.retryAfterMs },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  } catch {
    logServerEvent({ route: "/api/account/delete", event: "error", reasonCode: "rate_limit_storage_failed", status: 503 });
    return json({ error: "Could not verify request rate. Try again shortly." }, 503);
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
  // S2: retryability is only REAL because deleteBusinessMembers deletes the caller's OWN owner row last
  // (see its doc comment) - that row is the authorization anchor the retry re-reads.
  try {
    await recursiveDeleteBusiness(businessId);
    await deleteBusinessMembers(businessId, uid);
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
