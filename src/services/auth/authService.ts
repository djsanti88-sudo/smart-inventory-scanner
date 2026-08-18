// The provider-neutral auth and workspace ports.
//
// Before this file, authentication had no abstraction of any kind: `src/lib/auth.ts` WAS the Firebase
// client SDK, and three components imported `type { User } from "firebase/auth"` directly, so the
// vendor's user object was part of the UI's type surface. Of the ~30 members Firebase's `User`
// carries, this app reads exactly five - which is what `AuthUser` declares below.
//
// These are TYPES ONLY. There is no runtime indirection, no registry, no factory: `src/lib/auth.ts`
// remains the single Firebase implementation and callers keep importing it directly. The seam is
// enforced by the compiler through `src/lib/auth.contract.test.ts`, which fails the typecheck if the
// implementation stops matching these ports. That keeps the cost of the abstraction at zero runtime
// and one test file, while making the shape a second implementation would have to satisfy explicit.
//
// Deliberately NOT modelled here: anything Firebase-specific the app does not consume (refresh
// tokens, metadata, tenantId, multi-factor, reauthentication). A port should describe what callers
// need, not mirror the vendor.

import type { AuthFlowResult } from "@/services/auth/provisioningTypes";
import type { BusinessMember } from "@/services/db/types";

/**
 * The signed-in user, reduced to what this application actually reads.
 * Firebase's `User` is structurally assignable to this, so today's implementation satisfies it
 * without adapters or wrapping.
 */
export interface AuthUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  /** Which identity providers back this account (e.g. "password", "google.com"). */
  readonly providerData: readonly { readonly providerId: string }[];
  /** A bearer token for authenticated calls to this app's own API routes. */
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export type Membership = BusinessMember & { businessName: string };
export type AppRole = "owner" | "admin" | "counter" | "viewer";
export type CreatableMemberRole = Exclude<AppRole, "owner">;

/**
 * Session lifecycle and credential operations.
 *
 * Note the shape of the results: no method here throws for an expected failure. Sign-in returns an
 * `AuthFlowResult` describing the outcome, and the email operations return `{ error }`. That is a
 * real contract, not a style preference - the UI renders those strings, and a replacement provider
 * that threw instead would break every call site silently at runtime rather than at compile time.
 */
export interface AuthService {
  /** The current user once auth state has settled, or null. Never rejects. */
  getSession(): Promise<AuthUser | null>;
  /** Subscribe to sign-in/sign-out. Returns the unsubscribe function. */
  onAuthChange(callback: (user: AuthUser | null) => void): () => void;
  signInWithPassword(email: string, password: string): Promise<AuthFlowResult>;
  signInWithGoogle(): Promise<AuthFlowResult>;
  signUp(email: string, password: string): Promise<AuthFlowResult>;
  signOut(): Promise<void>;
  sendResetEmail(email: string): Promise<{ error: string | null }>;
  resendVerificationEmail(user: AuthUser): Promise<{ error: string | null }>;
}

/**
 * Tenant provisioning and membership. Separated from AuthService because these are business-domain
 * operations that merely happen to require an authenticated caller: they create and read the
 * `businesses` / `businessMembers` records, and a future provider swap would replace them
 * independently of the credential layer.
 */
export interface WorkspaceService {
  /** Repair or create the signed-in user's default workspace without re-authenticating. */
  ensureWorkspace(): Promise<AuthFlowResult>;
  createBusiness(name: string): Promise<{ businessId: string | null; error: string | null }>;
  createBusinessMember(input: {
    businessId: string;
    email: string;
    name: string;
    role: CreatableMemberRole;
    password?: string;
  }): Promise<{ uid: string | null; createdAuthUser: boolean; passwordSet: boolean; error: string | null }>;
  /** The signed-in user's memberships, each resolved to a readable business name. */
  listMemberships(): Promise<Membership[]>;
  /** Abandon one pending named-business creation without affecting other names. */
  abandonBusinessCreation(name: string): Promise<void>;
}
