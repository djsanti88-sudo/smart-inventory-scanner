"use client";

import { NeedsReviewTable } from "@/components/NeedsReviewTable";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { BusinessContextGate } from "@/components/BusinessContextGate";

export default function ReviewPage() {
  // Gate on a real business context too: resolving an unknown writes (SAVE_PRODUCT / RESOLVE_ALIAS),
  // which the Firebase backend pauses without a real businessId/userId. On a full reload to /review the
  // gate re-establishes context (from the signed-in user + selected business) so sync can drain.
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <BusinessContextGate>
        <SyncStatusBar />
        <NeedsReviewTable />
      </BusinessContextGate>
    </div>
  );
}
