"use client";

import { useState } from "react";
import { NeedsReviewTable } from "@/components/NeedsReviewTable";
import { SuggestedApprovalPanel } from "@/components/SuggestedApprovalPanel";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { BusinessContextGate } from "@/components/BusinessContextGate";

// Build 3: the review screen gains a "Suggested" tab for batch-approving the Suggested pile
// (docs/superpowers/specs/2026-07-05-batch-approve-design.md). "All" is the original single-row
// Needs Review table, unchanged. Tab state is local UI only - no store/approval semantics here.
export default function ReviewPage() {
  const [tab, setTab] = useState<"all" | "suggested">("all");
  const tabBase = "inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium";
  const tabActive = `${tabBase} bg-blue-600 text-white`;
  const tabInactive = `${tabBase} border border-zinc-300 text-zinc-700 hover:bg-zinc-50`;

  // Gate on a real business context too: resolving an unknown writes (SAVE_PRODUCT / RESOLVE_ALIAS),
  // which the Firebase backend pauses without a real businessId/userId. On a full reload to /review the
  // gate re-establishes context (from the signed-in user + selected business) so sync can drain.
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <BusinessContextGate>
        <SyncStatusBar />
        <div className="flex gap-2" role="tablist" aria-label="Review tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            data-testid="review-tab-all"
            onClick={() => setTab("all")}
            className={tab === "all" ? tabActive : tabInactive}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "suggested"}
            data-testid="review-tab-suggested"
            onClick={() => setTab("suggested")}
            className={tab === "suggested" ? tabActive : tabInactive}
          >
            Suggested
          </button>
        </div>
        {tab === "all" ? <NeedsReviewTable /> : <SuggestedApprovalPanel />}
      </BusinessContextGate>
    </div>
  );
}
