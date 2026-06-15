"use client";

import { NeedsReviewTable } from "@/components/NeedsReviewTable";
import { SyncStatusBar } from "@/components/SyncStatusBar";

export default function ReviewPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <SyncStatusBar />
      <NeedsReviewTable />
    </div>
  );
}
