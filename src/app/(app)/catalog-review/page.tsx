import { CatalogReviewTable } from "@/components/CatalogReviewTable";
import { BusinessContextGate } from "@/components/BusinessContextGate";

// Task 3 (owner step 3): platform-owner-only page for approving/rejecting pending catalogEntries
// (the shared master catalog). Deliberately not linked from the main Nav (owner did not ask for that);
// reachable directly at /catalog-review.
// BusinessContextGate applied here for CONSISTENCY with the other protected routes (/scan, /review,
// /history, /sessions/[id], /reconcile, /products, /settings) per coordinator instruction - NOTE this
// page is architecturally different from those: CatalogReviewTable never reads/sends businessId (it
// is a cross-tenant, platform-owner-only resource, authorized server-side via the Firebase id token
// only - see CatalogReviewTable.tsx). There is no demo-business leak risk here to fix; this wrap only
// adds the standard "signed in + a business selected" wall ahead of an otherwise business-agnostic
// admin page. Flagged in the fix report for owner awareness, not a functional bug fix like the other six.
export default function CatalogReviewPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <BusinessContextGate>
      <h1 className="text-xl font-semibold text-zinc-900">Catalog review</h1>
      <p className="text-sm text-zinc-600">
        Pending master catalog entries awaiting approval. Approve to mark an entry human verified,
        or reject entries that are wrong.
      </p>
      <CatalogReviewTable />
      </BusinessContextGate>
    </div>
  );
}
