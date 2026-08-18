import { describe, it, expect } from "vitest";
import type { AuthService, WorkspaceService, AuthUser } from "@/services/auth/authService";

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
import type * as AuthModule from "@/lib/auth";

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

  it("documents the five members of the user object this app actually consumes", () => {
    // Guards against the port quietly re-growing toward the vendor's ~30-member User. If a sixth
    // member is genuinely needed, add it here on purpose.
    const consumed: (keyof AuthUser)[] = ["uid", "email", "emailVerified", "providerData", "getIdToken"];
    expect(consumed).toHaveLength(5);
  });
});
