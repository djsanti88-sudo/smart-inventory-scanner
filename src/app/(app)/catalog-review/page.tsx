import { CatalogReviewTable } from "@/components/CatalogReviewTable";

// Task 3 (owner step 3): platform-owner-only page for approving/rejecting pending catalogEntries
// (the shared master catalog). Deliberately not linked from the main Nav (owner did not ask for that);
// reachable directly at /catalog-review.
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
