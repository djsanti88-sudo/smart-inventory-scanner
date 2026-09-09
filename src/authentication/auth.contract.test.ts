import { describe, it, expect } from "vitest";
import type { AuthService, WorkspaceService, AuthUser } from "@/authentication/service/authService";

// The seam that makes authentication replaceable.
//
// src/lib/auth.ts is the Firebase implementation of AuthService + WorkspaceService. Nothing at
// runtime enforces that - callers import its functions directly, by design, because a runtime
// registry would be indirection with exactly one entry. What enforces it is this file: the
// assertions below are TYPE assertions, checked by `tsc --noEmit` (which proof:all runs), and they
// fail the build the moment the implementation stops matching the port.
//
// The import is `import type * as`, so no Firebase SDK is loaded and no mocks are needed - this
// file is a compile-time contract with a runtime smoke test attached, not a behavior test. The
// behavior of each function is covered by auth.password/google/memberships/provisioning/
// resendVerificationEmail.test.ts.
import type * as AuthModule from "@/authentication/auth";

/** Compiles only when Actual structurally satisfies Port. */
type Satisfies<Actual extends Port, Port> = Actual;

// If either line below goes red, src/lib/auth.ts has drifted from the port: either fix the module,
// or change the port deliberately (and then every future implementation must follow).
// The aliases are unused BY DESIGN - evaluating the constraint is the whole point, so the lint rule
// that flags unused types is exactly wrong here.
/* eslint-disable @typescript-eslint/no-unused-vars */
type _AuthConformance = Satisfies<typeof AuthModule, AuthService>;
type _WorkspaceConformance = Satisfies<typeof AuthModule, WorkspaceService>;

// Firebase's User must remain assignable to AuthUser - that is what lets the implementation hand
// out real User objects with no wrapper or adapter allocation per call.
type FirebaseUserSubset = {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  providerData: { providerId: string; displayName: string | null }[];
  getIdToken(forceRefresh?: boolean): Promise<string>;
  // Members AuthUser deliberately does not model, present here to prove extra members are fine.
  refreshToken: string;
  tenantId: string | null;
};
type _FirebaseUserSatisfiesPort = Satisfies<FirebaseUserSubset, AuthUser>;
/* eslint-enable @typescript-eslint/no-unused-vars */

describe("auth port conformance", () => {
  it("is enforced at compile time, not here", () => {
    // This assertion is deliberately trivial. The real check is that this FILE COMPILES: the three
    // `Satisfies<...>` aliases above are the test, and `tsc --noEmit` is the runner. A runtime
    // assertion cannot verify a structural type contract - it can only sample it.
    expect(true).toBe(true);
  });

  it("pins the exact member set of AuthUser, so the port cannot quietly re-grow", () => {
    // `Record<keyof AuthUser, true>` is the load-bearing part: it requires EVERY key of AuthUser to
    // be present, so adding a sixth member to the port without adding it here is a TYPE ERROR.
    //
    // The obvious version of this test - `const consumed: (keyof AuthUser)[] = [...]` - looks
    // equivalent and is not. That type only constrains each listed string to be *a* valid key; it
    // never requires *all* of them, so a sixth member would slip past silently. (Caught in review of
    // this very file, which had the weaker form.)
    const CONSUMED: Record<keyof AuthUser, true> = {
      uid: true,
      email: true,
      emailVerified: true,
      providerData: true,
      getIdToken: true,
    };
    // The count then guards the other direction: a member REMOVED from AuthUser while still listed
    // here is an excess-property type error, and this keeps the intended size explicit.
    expect(Object.keys(CONSUMED)).toHaveLength(5);
  });
});
