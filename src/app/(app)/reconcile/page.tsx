import { ReconcilePanel } from "@/reconcile/ReconcilePanel";
import { BusinessContextGate } from "@/users-businesses/BusinessContextGate";

// Reconcile page (Task 7): its own page, away from the scan flow (scanner flow untouched).
// BusinessContextGate wraps the content (same convention as /scan, /review, /history,
// /sessions/[id]) so a hard page load directly on this route waits for the real signed-in
// business context to hydrate before ReconcilePanel can fire /api/reconcile/match - otherwise the
// request goes out scoped to the coded mock default (demo-business) instead of the real tenant.
export default function ReconcilePage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <BusinessContextGate>
        <ReconcilePanel />
      </BusinessContextGate>
    </div>
  );
}
