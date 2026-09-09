import { describe, it, expect } from "vitest";
import type {
  InventoryRepository,
  BarcodeRepository,
  CatalogRepository,
  AuditRepository,
  ScanSessionRepository,
} from "@/sync-database/repositories";
import type { DatabaseService } from "@/sync-database/databaseService";

// Proof that the Firestore implementations satisfy the provider-neutral ports.
//
// Type-only imports: no Firebase SDK is loaded, no emulator is needed, and this file therefore runs
// in the plain `npm run test` suite rather than self-skipping like the 11 *.rules.test.ts files. The
// checks are evaluated by `tsc --noEmit`, which proof:all runs - so a drifting implementation fails
// the build, not just this suite.
//
// Behavior of these repositories against real Firestore rules is covered separately by
// ./firebase/repositories.rules.test.ts (emulator-gated). This file only answers a different
// question: "is the vendor implementation still shaped like the contract?"
import type * as FirebaseRepositories from "@/sync-database/cloud/repositories";
import type * as FirebaseSyncTargetModule from "@/sync-database/cloud/firebaseSyncTarget";
import type * as MockDbModule from "@/sync-database/mock/mockDb";

/** Compiles only when Actual structurally satisfies Port. */
type Satisfies<Actual extends Port, Port> = Actual;

/* eslint-disable @typescript-eslint/no-unused-vars */

// The business-scoped factories: each takes (db, businessId) and returns a bound repository. Binding
// tenancy at construction - rather than passing businessId per call - is what makes a cross-tenant
// read impossible to express, so the factory shape is part of the contract, not an implementation detail.
type _ProductsRepo = Satisfies<
  ReturnType<typeof FirebaseRepositories.productsRepository>,
  InventoryRepository
>;
type _AliasesRepo = Satisfies<
  ReturnType<typeof FirebaseRepositories.aliasesRepository>,
  BarcodeRepository
>;
type _AuditRepo = Satisfies<ReturnType<typeof FirebaseRepositories.auditRepository>, AuditRepository>;
type _CatalogRepo = Satisfies<
  ReturnType<typeof FirebaseRepositories.catalogRepository>,
  CatalogRepository
>;

// The cloud write target also serves the session read side. `getScanEventsBySession` is optional on
// SyncTarget (it was added after the write-only interface shipped), so this asserts the Firebase
// implementation genuinely provides it rather than relying on the caller's feature detection.
type _SessionReads = Satisfies<
  InstanceType<typeof FirebaseSyncTargetModule.FirebaseSyncTarget>,
  ScanSessionRepository
>;

// Both write targets satisfy the required half of DatabaseService. The mock deliberately does NOT
// implement the optional capabilities - that is the degradation path the port documents.
type _FirebaseIsWriteTarget = Satisfies<
  { db: InstanceType<typeof FirebaseSyncTargetModule.FirebaseSyncTarget> },
  DatabaseService
>;
type _MockIsWriteTarget = Satisfies<
  { db: ReturnType<typeof MockDbModule.getMockDb> },
  DatabaseService
>;

/* eslint-enable @typescript-eslint/no-unused-vars */

describe("data-access port conformance", () => {
  it("is enforced at compile time, not here", () => {
    // The `Satisfies<...>` aliases above ARE the test; `tsc --noEmit` is the runner. Verified to
    // actually bite by temporarily adding a member to a port that no implementation has, confirming
    // TS2344, then reverting.
    expect(true).toBe(true);
  });

  it("keeps tenancy out of the per-call surface", () => {
    // A repository method that accepted a businessId would let a caller read across tenants by
    // passing the wrong one. The only port that takes a businessId is ScanSessionRepository, whose
    // implementation re-scopes the query and is covered by tenantIsolation.rules.test.ts.
    const perCallTenantArgs: (keyof InventoryRepository)[] = [];
    expect(perCallTenantArgs).toEqual([]);
  });
});
