"use client";

import {
  type User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  sendPasswordResetEmail,
} from "firebase/auth";
import { doc, getDoc, getDocs, query, collection, where } from "firebase/firestore";
import { getFirebaseAuth, getDb } from "@/lib/firebaseClient";
import { getSelectedBusinessId } from "@/lib/selectedBusiness";
import { isAuthBypassEnabled } from "@/services/auth/authBypass";
import { firebaseAuthErrorMessage, isPopupCancellation } from "@/services/auth/firebaseError";
import type {
  AuthFlowResult,
  ProvisionRequest,
  ProvisionResponse,
} from "@/services/auth/provisioningTypes";
import { COLLECTIONS, type BusinessMember } from "@/services/db/types";
import { retryingRead } from "@/services/db/firebase/boundedRead";

// Firebase Auth for the launch MVP (email/password; structured so Google can be added later). The
// Admin SDK / service account is NEVER imported here. The guarded E2E/test bypass keeps Playwright specs
// green and is impossible in production (src/services/auth/authBypass.ts).

export { isAuthBypassEnabled };
export type AppRole = "owner" | "admin" | "counter" | "viewer";
export type Membership = BusinessMember & { businessName: string };
export type CreatableMemberRole = Exclude<AppRole, "owner">;

const E2E_USER = { uid: "e2e-user", email: "e2e@test.local" } as unknown as User;
const BUSINESS_REQUEST_PREFIX = "sis-business-create-request-v2:";
const BUSINESS_INDEX_PREFIX = "sis-business-create-index-v2:";
const OPAQUE_FINGERPRINT = /^[a-f0-9]{64}$/;
const pendingBusinessRequestIds = new Map<string, string>();

/** Resolves the current user once auth state settles (Firebase currentUser is null until then). */
export async function getSession(): Promise<User | null> {
  if (isAuthBypassEnabled()) return E2E_USER;
  const auth = getFirebaseAuth();
  if (auth.currentUser) return auth.currentUser;
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => {
      unsub();
      resolve(u);
    });
  });
}

export function onAuthChange(cb: (user: User | null) => void): () => void {
  if (isAuthBypassEnabled()) return () => {};
  return onAuthStateChanged(getFirebaseAuth(), cb);
}

const WORKSPACE_SETUP_ERROR = "Your account is ready, but workspace setup did not finish.";

function normalizedBusinessName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

async function opaqueFingerprint(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function businessRequestFingerprint(uid: string, normalizedName: string): Promise<string> {
  return opaqueFingerprint(`business-request\u0000${uid}\u0000${normalizedName}`);
}

async function userStorageFingerprint(uid: string): Promise<string> {
  return opaqueFingerprint(`business-request-index\u0000${uid}`);
}

function requestStorageKey(fingerprint: string): string {
  return `${BUSINESS_REQUEST_PREFIX}${fingerprint}`;
}

function indexStorageKey(userFingerprint: string): string {
  return `${BUSINESS_INDEX_PREFIX}${userFingerprint}`;
}

function sessionValue(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSessionValue(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // In-memory tracking still preserves idempotency for the current page lifetime.
  }
}

function readFingerprintIndex(userFingerprint: string): string[] {
  const raw = sessionValue(indexStorageKey(userFingerprint));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter(
        (value): value is string => typeof value === "string" && OPAQUE_FINGERPRINT.test(value),
      ))]
      : [];
  } catch {
    return [];
  }
}

function writeFingerprintIndex(userFingerprint: string, fingerprints: string[]): void {
  const key = indexStorageKey(userFingerprint);
  if (fingerprints.length === 0) {
    setSessionValue(key, null);
  } else {
    setSessionValue(key, JSON.stringify([...new Set(fingerprints)].sort()));
  }
}

async function clearPendingBusinessRequest(uid: string, normalizedName: string): Promise<void> {
  const [fingerprint, userFingerprint] = await Promise.all([
    businessRequestFingerprint(uid, normalizedName),
    userStorageFingerprint(uid),
  ]);
  pendingBusinessRequestIds.delete(fingerprint);
  setSessionValue(requestStorageKey(fingerprint), null);
  writeFingerprintIndex(
    userFingerprint,
    readFingerprintIndex(userFingerprint).filter((value) => value !== fingerprint),
  );
}

async function pendingBusinessRequestId(uid: string, normalizedName: string): Promise<string> {
  const [fingerprint, userFingerprint] = await Promise.all([
    businessRequestFingerprint(uid, normalizedName),
    userStorageFingerprint(uid),
  ]);
  const key = requestStorageKey(fingerprint);
  const requestId = pendingBusinessRequestIds.get(fingerprint)
    ?? sessionValue(key)
    ?? crypto.randomUUID();
  pendingBusinessRequestIds.set(fingerprint, requestId);
  setSessionValue(key, requestId);
  writeFingerprintIndex(
    userFingerprint,
    [...readFingerprintIndex(userFingerprint), fingerprint],
  );
  return requestId;
}

async function clearAllPendingBusinessRequests(uid: string): Promise<void> {
  const userFingerprint = await userStorageFingerprint(uid);
  for (const fingerprint of readFingerprintIndex(userFingerprint)) {
    pendingBusinessRequestIds.delete(fingerprint);
    setSessionValue(requestStorageKey(fingerprint), null);
  }
  writeFingerprintIndex(userFingerprint, []);
}

/** Explicitly abandon one ambiguous named-business request without affecting other names. */
export async function abandonBusinessCreation(name: string): Promise<void> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return;
  await clearPendingBusinessRequest(user.uid, normalizedBusinessName(name));
}

async function requestProvision(
  user: User,
  input: ProvisionRequest,
): Promise<ProvisionResponse> {
  const idToken = await user.getIdToken();
  const response = await fetch("/api/businesses/provision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as ProvisionResponse | null;
  if (
    body
    && (body.status === "ready" || body.status === "existing")
    && typeof body.businessId === "string"
    && body.businessId
  ) {
    return body;
  }
  if (
    body?.status === "selection_required"
    && Array.isArray(body.businessIds)
    && body.businessIds.every((businessId) => typeof businessId === "string")
  ) {
    return body;
  }
  return {
    status: "failed",
    reason: body?.status === "failed" ? body.reason : "workspace_unavailable",
  };
}

async function finishAuthentication(
  user: User,
  accountCreated: boolean,
): Promise<AuthFlowResult> {
  try {
    const preferredBusinessId = getSelectedBusinessId();
    const provision = await requestProvision(user, {
      mode: "ensure_default",
      ...(preferredBusinessId ? { preferredBusinessId } : {}),
    });
    if (provision.status === "ready" || provision.status === "existing") {
      return {
        status: "ready",
        accountCreated,
        businessId: provision.businessId,
        error: null,
      };
    }
    if (provision.status === "selection_required") {
      return {
        status: "selection_required",
        accountCreated,
        businessId: null,
        businessIds: provision.businessIds,
        error: null,
      };
    }
  } catch {
    // The Firebase account remains authenticated. The caller receives a repairable workspace state.
  }
  return {
    status: "workspace_failed",
    accountCreated,
    businessId: null,
    error: WORKSPACE_SETUP_ERROR,
  };
}

export async function signInWithPassword(email: string, password: string): Promise<AuthFlowResult> {
  try {
    const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
    return finishAuthentication(cred.user, false);
  } catch (e) {
    return {
      status: "auth_failed",
      accountCreated: false,
      businessId: null,
      error: firebaseAuthErrorMessage(e),
    };
  }
}

export async function signUp(email: string, password: string): Promise<AuthFlowResult> {
  try {
    const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
    return finishAuthentication(cred.user, true);
  } catch (e) {
    return {
      status: "auth_failed",
      accountCreated: false,
      businessId: null,
      error: firebaseAuthErrorMessage(e),
    };
  }
}

/** Google sign-in via popup. Workspace provisioning is shared with password login and sign-up. */
export async function signInWithGoogle(): Promise<AuthFlowResult> {
  try {
    const cred = await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    return finishAuthentication(cred.user, false);
  } catch (e) {
    if (isPopupCancellation(e)) {
      return {
        status: "cancelled",
        accountCreated: false,
        businessId: null,
        error: null,
      };
    }
    return {
      status: "auth_failed",
      accountCreated: false,
      businessId: null,
      error: firebaseAuthErrorMessage(e),
    };
  }
}

/** Send a Firebase password-reset email. Errors (e.g. unknown address) are returned, not thrown. */
export async function sendResetEmail(email: string): Promise<{ error: string | null }> {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email.trim());
    return { error: null };
  } catch (e) {
    return { error: firebaseAuthErrorMessage(e) };
  }
}

export async function signOut(): Promise<void> {
  if (isAuthBypassEnabled()) return;
  const auth = getFirebaseAuth();
  try {
    if (auth.currentUser) await clearAllPendingBusinessRequests(auth.currentUser.uid);
  } finally {
    await fbSignOut(auth);
  }
}

/** Retry the authenticated user's default workspace repair without signing in again. */
export async function ensureWorkspace(): Promise<AuthFlowResult> {
  const user = getFirebaseAuth().currentUser;
  if (!user) {
    return {
      status: "auth_failed",
      accountCreated: false,
      businessId: null,
      error: "Sign in to continue.",
    };
  }
  return finishAuthentication(user, false);
}

/** Create a business and owner membership atomically through the authenticated server route. */
export async function createBusiness(name: string): Promise<{ businessId: string | null; error: string | null }> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return { businessId: null, error: "Not signed in." };
  const trimmedName = name.trim().replace(/\s+/g, " ");
  const normalizedName = normalizedBusinessName(trimmedName);
  const input: ProvisionRequest = {
    mode: "create_named",
    name: trimmedName,
    requestId: await pendingBusinessRequestId(user.uid, normalizedName),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await requestProvision(user, input);
      if (result.status === "ready" || result.status === "existing") {
        await clearPendingBusinessRequest(user.uid, normalizedName);
        return { businessId: result.businessId, error: null };
      }
    } catch {
      // One immediate retry reuses the same request ID, so a lost response cannot duplicate a business.
    }
  }
  return { businessId: null, error: "We could not create the business. Please try again." };
}

/** Create or link a Firebase Auth user, then add that uid to the selected business. */
export async function createBusinessMember(input: {
  businessId: string;
  email: string;
  name: string;
  role: CreatableMemberRole;
  password?: string;
}): Promise<{ uid: string | null; createdAuthUser: boolean; passwordSet: boolean; error: string | null }> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return { uid: null, createdAuthUser: false, passwordSet: false, error: "Not signed in." };
  const idToken = await user.getIdToken();
  const response = await fetch("/api/businesses/members", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as {
    ok?: unknown;
    uid?: unknown;
    createdAuthUser?: unknown;
    passwordSet?: unknown;
    reason?: unknown;
  } | null;
  if (response.ok && body?.ok === true && typeof body.uid === "string") {
    return {
      uid: body.uid,
      createdAuthUser: body.createdAuthUser === true,
      passwordSet: body.passwordSet === true,
      error: null,
    };
  }
  const reason = typeof body?.reason === "string" ? body.reason : "";
  if (reason === "owner_required") {
    return { uid: null, createdAuthUser: false, passwordSet: false, error: "Only the business owner can add users." };
  }
  if (reason === "auth_user_unavailable") {
    return { uid: null, createdAuthUser: false, passwordSet: false, error: "We could not create that Firebase login. Please try again." };
  }
  return { uid: null, createdAuthUser: false, passwordSet: false, error: "We could not add that user. Please try again." };
}

/**
 * The signed-in user's memberships (rules scope reads to their own). Called from the fresh-device
 * bootstrap chain (BusinessContextGate, with its own outer timeout) AND directly by other pages
 * (e.g. the business switcher) with no outer timeout of their own - so every getDocs/getDoc here is
 * bounded via ./boundedRead's retryingRead, matching businessDataLoader.ts, instead of relying on a
 * caller-supplied timeout that may not exist.
 */
export async function listMemberships(): Promise<Membership[]> {
  if (isAuthBypassEnabled()) return [];
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return [];
  const db = getDb();
  const snap = await retryingRead("your memberships", () =>
    getDocs(query(collection(db, COLLECTIONS.businessMembers), where("userId", "==", user.uid))),
  );
  const memberships = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as BusinessMember);
  const validated = await Promise.all(memberships.map(async (membership) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(membership.businessId)) return null;
    let business: Awaited<ReturnType<typeof getDoc>>;
    try {
      business = await retryingRead("a business record", () => getDoc(doc(db, COLLECTIONS.businesses, membership.businessId)));
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      // Rules deny reads through an orphan membership because its parent no longer exists.
      if (code === "permission-denied" || code === "firestore/permission-denied") return null;
      throw error;
    }
    if (!business.exists()) return null;
    const rawName = (business.data() as { name?: unknown } | undefined)?.name;
    return {
      ...membership,
      businessName:
        typeof rawName === "string" && rawName.trim()
          ? rawName.trim()
          : "Unnamed business",
    } satisfies Membership;
  }));
  return validated.filter((membership): membership is Membership => membership !== null);
}
