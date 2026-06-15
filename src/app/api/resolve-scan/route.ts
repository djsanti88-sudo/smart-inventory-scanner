import "server-only";

import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { accessLevelServer } from "@/services/security/roleAccess";
import { resolveScanForRole } from "@/services/security/resolveScanServer";
import { toStoreProduct, toStoreAlias } from "@/services/db/firebase/businessDataLoader";
import type { Product, Alias } from "@/types";

// Sec-5: PROTECTED server-side customer scan resolution.
//
// A customer (non-platformOwner) sends ONLY the raw scanned code + their businessId + their Firebase
// ID token. The server verifies the token, confirms membership, reads the business's products/aliases
// SERVER-SIDE (elevated, via the Admin SDK), runs the DETERMINISTIC resolver, and returns ONLY the
// sanitized product-facing result. The customer browser therefore never has to download or hold the
// alias/catalog database to resolve a scan. platformOwner gets the full internal result.
//
// CREDENTIALS NOTE (honest): the Admin SDK needs either the Firestore emulator (no creds) OR a
// service-account credential (FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS) for the
// real cloud project. When neither is present, getAdminDb()/verifyIdToken throw; we catch that and
// return 503 { reason: "server_resolution_unavailable" } so the client falls back gracefully instead
// of crashing a scan. Activating this on the real cloud is an ops step (drop a service-account JSON),
// not a code change.

export const runtime = "nodejs"; // Admin SDK requires the Node runtime, not edge.

interface ResolveScanBody {
  rawInput?: string;
  businessId?: string;
  idToken?: string;
}

export async function POST(request: Request) {
  let body: ResolveScanBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const rawInput = (body.rawInput ?? "").toString();
  const businessId = (body.businessId ?? "").toString();
  const idToken = (body.idToken ?? "").toString();

  if (!rawInput.trim()) return Response.json({ ok: false, error: "Missing rawInput" }, { status: 400 });
  if (!businessId.trim()) return Response.json({ ok: false, error: "Missing businessId" }, { status: 400 });
  if (!idToken.trim()) return Response.json({ ok: false, error: "Missing idToken" }, { status: 401 });

  // 1. Verify the caller's identity from their Firebase ID token (Admin Auth).
  let uid = "";
  let email: string | null = null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
    email = decoded.email ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Distinguish "no server credentials configured" (ops/deploy gap) from "bad/expired token" (401).
    if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(msg)) {
      return Response.json(
        { ok: false, reason: "server_resolution_unavailable", error: "Server resolution is not configured." },
        { status: 503 },
      );
    }
    return Response.json({ ok: false, error: "Invalid or expired ID token" }, { status: 401 });
  }

  const level = accessLevelServer({ uid, email });

  // 2. Read the business's products + aliases server-side (elevated). platformOwner may resolve against
  //    any business; a customer must be a member of the business they are scanning for.
  let products: Product[];
  let aliases: Alias[];
  try {
    const db = getAdminDb();
    if (level !== "platform") {
      const member = await db.doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`).get();
      if (!member.exists) {
        return Response.json({ ok: false, error: "Not a member of this business" }, { status: 403 });
      }
    }
    const [psnap, asnap] = await Promise.all([
      db.collection(COLLECTIONS.businesses).doc(businessId).collection(COLLECTIONS.products).get(),
      db.collection(COLLECTIONS.businesses).doc(businessId).collection(COLLECTIONS.aliases).get(),
    ]);
    products = psnap.docs.map((d) => toStoreProduct(d.id, d.data() as Record<string, unknown>, businessId));
    aliases = asnap.docs.map((d) => toStoreAlias(d.id, d.data() as Record<string, unknown>, businessId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(msg)) {
      return Response.json(
        { ok: false, reason: "server_resolution_unavailable", error: "Server resolution is not configured." },
        { status: 503 },
      );
    }
    return Response.json({ ok: false, error: "Failed to read business data" }, { status: 500 });
  }

  // 3. Resolve deterministically + shape for the caller's role. Customer => product-facing only.
  const result = resolveScanForRole({ rawInput, businessId, level, products, aliases });
  return Response.json({ ok: true, level, result });
}
