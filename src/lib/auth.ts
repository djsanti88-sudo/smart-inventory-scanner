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
import { doc, setDoc, getDocs, query, collection, where, serverTimestamp } from "firebase/firestore";
import { getFirebaseAuth, getDb } from "@/lib/firebaseClient";
import { isAuthBypassEnabled } from "@/services/auth/authBypass";
import { COLLECTIONS, memberDocId, type BusinessMember } from "@/services/db/types";

// Firebase Auth for the launch MVP (email/password; structured so Google can be added later). The
// Admin SDK / service account is NEVER imported here. The guarded E2E/test bypass keeps Playwright specs
// green and is impossible in production (src/services/auth/authBypass.ts).

export { isAuthBypassEnabled };
export type AppRole = "owner" | "admin" | "counter" | "viewer";
export type Membership = BusinessMember;

const E2E_USER = { uid: "e2e-user", email: "e2e@test.local" } as unknown as User;

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

function message(e: unknown): string {
  return e instanceof Error ? e.message : "Authentication error";
}

export async function signInWithPassword(email: string, password: string): Promise<{ error: string | null }> {
  try {
    await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function signUp(email: string, password: string): Promise<{ error: string | null }> {
  try {
    const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
    await ensureUserProfile(cred.user);
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

/** Google sign-in via popup. On success, ensures the user's profile doc exists (same as email sign-up). */
export async function signInWithGoogle(): Promise<{ error: string | null }> {
  try {
    const cred = await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    await ensureUserProfile(cred.user);
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

/** Send a Firebase password-reset email. Errors (e.g. unknown address) are returned, not thrown. */
export async function sendResetEmail(email: string): Promise<{ error: string | null }> {
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), email.trim());
    return { error: null };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function signOut(): Promise<void> {
  if (isAuthBypassEnabled()) return;
  await fbSignOut(getFirebaseAuth());
}

/** Create the user's profile doc on first login (doc id = uid; a user may only write their own). */
export async function ensureUserProfile(user: User): Promise<void> {
  const db = getDb();
  await setDoc(
    doc(db, COLLECTIONS.userProfiles, user.uid),
    { authUserId: user.uid, email: user.email ?? "", name: user.displayName ?? "", updatedAt: serverTimestamp() },
    { merge: true },
  );
}

/** Create a business and the creator's owner membership (allowed by the bootstrap security rules). */
export async function createBusiness(name: string): Promise<{ businessId: string | null; error: string | null }> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return { businessId: null, error: "Not signed in." };
  try {
    const db = getDb();
    const businessId = crypto.randomUUID();
    await setDoc(doc(db, COLLECTIONS.businesses, businessId), {
      name: name.trim(),
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await setDoc(doc(db, COLLECTIONS.businessMembers, memberDocId(businessId, user.uid)), {
      businessId,
      userId: user.uid,
      role: "owner",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { businessId, error: null };
  } catch (e) {
    return { businessId: null, error: message(e) };
  }
}

/** The signed-in user's memberships (rules scope reads to their own). */
export async function listMemberships(): Promise<Membership[]> {
  if (isAuthBypassEnabled()) return [];
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return [];
  const db = getDb();
  const snap = await getDocs(query(collection(db, COLLECTIONS.businessMembers), where("userId", "==", user.uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Membership);
}
