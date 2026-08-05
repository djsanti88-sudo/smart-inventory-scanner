import { CatalogReviewTable } from "@/components/CatalogReviewTable";

// Task 3 (owner step 3): platform-owner-only page for approving/rejecting pending catalogEntries
// (the shared master catalog). Deliberately not linked from the main Nav (owner did not ask for that);
// reachable directly at /catalog-review.
// DELIBERATELY UNGATED (Codex final verdict, 2026-08-05, finding 4 - final ruling): a BusinessContextGate
// wrapper was briefly added here "for consistency" with the other protected routes, but this page is
// architecturally different from those - CatalogReviewTable never reads/sends businessId (it is a
// cross-tenant, platform-owner-only resource, authorized server-side via the Firebase id token only, see
// CatalogReviewTable.tsx) and has no demo-business leak risk to fix. BusinessContextGate requires a
// SELECTED business membership (BusinessContextGate.tsx's "no-business" branch); a correctly authenticated
// platform owner with no selected shop was therefore wrongly locked out of this business-agnostic admin
// queue. Reverted to the original ungated behavior - CatalogReviewTable's own useIsPlatformOwner check
// (client hint only; the server route re-verifies) is the sole gate this page needs.
export default function CatalogReviewPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold text-zinc-900">Catalog review</h1>
      <p className="text-sm text-zinc-600">
        Pending master catalog entries awaiting approval. Approve to mark an entry human verified,
        or reject entries that are wrong.
      </p>
      <CatalogReviewTable />
    </div>
  );
}
