import { ReconcilePanel } from "@/components/ReconcilePanel";

// Reconcile page (Task 7): its own page, away from the scan flow (scanner flow untouched).
export default function ReconcilePage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <ReconcilePanel />
    </div>
  );
}
