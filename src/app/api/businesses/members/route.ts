import { FieldValue } from "firebase-admin/firestore";
import type { UserRecord } from "firebase-admin/auth";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId, type Role } from "@/services/db/types";

export const runtime = "nodejs";

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SAFE_ROLES = new Set<Role>(["admin", "counter", "viewer"]);

class OwnerRoleChangeError extends Error {}

interface MemberCreateRequest {
  businessId: string;
  email: string;
  name: string;
  role: Role;
  password?: string;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function cleanName(value: unknown, email: string): string {
  if (typeof value !== "string") return email;
  return value.trim().replace(/\s+/g, " ").slice(0, 100) || email;
}

function cleanPassword(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  if (value.length < 8 || value.length > 128) return null;
  return value;
}

function parseRequest(value: unknown): MemberCreateRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  const businessId = typeof input.businessId === "string" ? input.businessId.trim() : "";
  const email = cleanEmail(input.email);
  const password = cleanPassword(input.password);
  const role = typeof input.role === "string" ? input.role : "";
  if (!BUSINESS_ID_PATTERN.test(businessId) || !email || password === null || !SAFE_ROLES.has(role as Role)) return null;
  return {
    businessId,
    email,
    name: cleanName(input.name, email),
    role: role as Role,
    ...(password ? { password } : {}),
  };
}

async function verifiedOwnerUid(request: Request, businessId: string): Promise<string | Response> {
  const token = bearerToken(request);
  if (!token) return json({ ok: false, reason: "not_authenticated" }, 401);

  let decoded: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decoded = await getAdminAuth().verifyIdToken(token);
  } catch {
    return json({ ok: false, reason: "not_authenticated" }, 401);
  }

  const uid = decoded.uid;
  try {
    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`)
      .get();
    const role = member.exists ? member.data()?.role : undefined;
    if (role !== "owner") return json({ ok: false, reason: "owner_required" }, 403);
  } catch {
    return json({ ok: false, reason: "membership_check_failed" }, 503);
  }
  return uid;
}

async function authUserForEmail(email: string, name: string, password?: string) {
  const auth = getAdminAuth();
  try {
    const user = await auth.getUserByEmail(email);
    return { user, created: false };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code !== "auth/user-not-found") throw error;
  }

  try {
    const user = await auth.createUser({
      email,
      displayName: name,
      emailVerified: false,
      disabled: false,
      ...(password ? { password } : {}),
    });
    return { user, created: true };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    if (code !== "auth/email-already-exists") throw error;
    const user = await auth.getUserByEmail(email);
    return { user, created: false };
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, reason: "invalid_request" }, 400);
  }
  const input = parseRequest(body);
  if (!input) return json({ ok: false, reason: "invalid_request" }, 400);

  const ownerUid = await verifiedOwnerUid(request, input.businessId);
  if (ownerUid instanceof Response) return ownerUid;

  let authUser: UserRecord;
  let createdAuthUser = false;
  try {
    const result = await authUserForEmail(input.email, input.name, input.password);
    authUser = result.user;
    createdAuthUser = result.created;
  } catch {
    return json({ ok: false, reason: "auth_user_unavailable" }, 503);
  }

  const timestamp = FieldValue.serverTimestamp();
  try {
    const db = getAdminDb();
    const profileRef = db.doc(`${COLLECTIONS.userProfiles}/${authUser.uid}`);
    const memberRef = db.doc(
      `${COLLECTIONS.businessMembers}/${memberDocId(input.businessId, authUser.uid)}`,
    );

    // Read-then-write inside a transaction closes the TOCTOU gap: the target's existing
    // membership role must be checked in the same atomic operation as the write, otherwise
    // a concurrent request could still race an owner role change through. This is the only
    // guard against overwriting an existing owner's role (SAFE_ROLES only restricts the
    // *requested* role, never the *target's current* role) — see verify/v1-owner-demotion.md.
    await db.runTransaction(async (tx) => {
      const existingMember = await tx.get(memberRef);
      if (existingMember.exists && existingMember.data()?.role === "owner") {
        throw new OwnerRoleChangeError();
      }
      tx.set(profileRef, {
        authUserId: authUser.uid,
        email: authUser.email ?? input.email,
        name: input.name,
        updatedAt: timestamp,
        ...(createdAuthUser ? { createdAt: timestamp, signedUpAt: timestamp } : {}),
      }, { merge: true });
      tx.set(memberRef, {
        businessId: input.businessId,
        userId: authUser.uid,
        role: input.role,
        invitedBy: ownerUid,
        updatedAt: timestamp,
        ...(createdAuthUser ? { createdAt: timestamp } : {}),
      }, { merge: true });
    });
  } catch (error) {
    if (error instanceof OwnerRoleChangeError) {
      return json({ ok: false, reason: "cannot_change_owner_role" }, 403);
    }
    return json({ ok: false, reason: "member_link_unavailable" }, 503);
  }

  return json({
    ok: true,
    uid: authUser.uid,
    email: authUser.email ?? input.email,
    role: input.role,
    createdAuthUser,
    passwordSet: createdAuthUser && Boolean(input.password),
  }, 200);
}
