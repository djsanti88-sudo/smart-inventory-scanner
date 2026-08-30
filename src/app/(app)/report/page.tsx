"use client";

import { useState } from "react";
import { getSession } from "@/authentication/auth";
import { isLiveAuth } from "@/authentication/service/authMode";
import { buildBossReport } from "@/services/reports/bossReport";
import { useScanStore } from "@/stores/scanStore";
import { BusinessContextGate } from "@/users-businesses/BusinessContextGate";

// BusinessContextGate (same convention as /scan, /review, /history, /sessions/[id], /reconcile,
// /products, /settings): a hard page load directly on /report must wait for the real signed-in
// business context to hydrate before "Get shareable link" can send businessId to /api/share -
// otherwise it would send the coded mock default (demo-business) instead of the real tenant (same
// bug class as the /reconcile 403).
export default function BossReportPage() {
  const products = useScanStore((state) => state.products);
  const finalCounts = useScanStore((state) => state.finalCounts);
  const scanFeed = useScanStore((state) => state.scanFeed);
  const session = useScanStore((state) => state.currentSession);
  const userId = useScanStore((state) => state.userId);
  const businessId = useScanStore((state) => state.businessId);
  const countSnapshots = useScanStore((state) => state.countSnapshots);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const previousSnapshot = countSnapshots[countSnapshots.length - 2];
  const currentSnapshotForVariance = countSnapshots[countSnapshots.length - 1];
  const buildCurrentReport = () =>
    buildBossReport({
      products,
      finalCounts,
      scanFeed,
      sessionName: session?.name ?? "Current session",
      countedBy: userId ?? "Owner",
      countedAt: new Date().toISOString(),
      previousSnapshot,
      currentSnapshotForVariance,
      // F2 fix: scope the report (and the minted public share snapshot) to the current session only,
      // so a cross-device refresh's additive merge never leaks other sessions' totals.
      currentSessionId: session?.id,
    });
  const report = buildCurrentReport();

  async function handleShare() {
    setSharing(true);
    setShareError(null);

    try {
      const reportSnapshot = buildCurrentReport();
      let idToken: string | undefined;

      if (isLiveAuth()) {
        const user = await getSession();
        if (!user) {
          setShareError("Sign in required.");
          return;
        }
        idToken = await user.getIdToken();
      }

      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          reportSnapshot,
          sessionId: session?.id ?? "",
          ...(idToken ? { idToken } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setShareError(body.error ?? "Could not create a shareable link right now.");
        return;
      }

      const body = await response.json();
      setShareUrl(body.url);
    } catch {
      setShareError("Could not create a shareable link right now.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="boss-report-page mx-auto flex max-w-3xl flex-col gap-4 p-4 print:p-0">
      <BusinessContextGate>
      <style>{`
        @media print {
          @page {
            margin: 0.5in;
          }

          nav,
          header,
          .boss-report-screen-only {
            display: none !important;
          }

          body,
          main {
            background: white !important;
          }

          .boss-report-page {
            max-width: none !important;
            padding: 0 !important;
          }

          .boss-report-body {
            border: 0 !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
        }
      `}</style>

      <div className="boss-report-screen-only flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Boss Report</h1>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="print-report"
            onClick={() => window.print()}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Print
          </button>
          <button
            type="button"
            data-testid="share-report"
            disabled={sharing || !session}
            onClick={() => void handleShare()}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {sharing ? "Creating link..." : "Get shareable link"}
          </button>
        </div>
      </div>

      {shareError && (
        <p className="boss-report-screen-only text-sm text-red-600" data-testid="share-error">
          {shareError}
        </p>
      )}
      {shareUrl && (
        <p className="boss-report-screen-only text-sm text-zinc-700" data-testid="share-url">
          Share this link:{" "}
          <a href={shareUrl} className="text-blue-700 underline">
            {shareUrl}
          </a>
        </p>
      )}

      <div
        className="boss-report-body rounded-lg border border-zinc-200 bg-white p-6 print:border-0 print:p-0"
        data-testid="boss-report-body"
      >
        <p className="text-lg font-semibold text-emerald-700" data-testid="report-moat-line">
          {report.moat.identified} of {report.moat.total} items identified automatically - no manual entry
        </p>
        <h2 className="mt-4 text-2xl font-bold text-zinc-900">{report.sessionName}</h2>
        <p className="text-sm text-zinc-600">
          Counted by {report.countedBy} on {new Date(report.countedAt).toLocaleString()}
        </p>
        <p className="mt-4 text-lg" data-testid="report-total-items">
          Total items: <strong>{report.totalItems}</strong>
        </p>
        {report.hasAnyCostData && (
          <p className="text-lg" data-testid="report-total-value">
            Estimated value: <strong>${report.totalValue!.toFixed(2)}</strong>
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <h3 className="font-semibold text-zinc-800">By brand</h3>
            <ul className="text-sm text-zinc-700">
              {report.byBrand.map((brand) => (
                <li key={brand.brand}>
                  {brand.brand}: {brand.qty}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-zinc-800">By category</h3>
            <ul className="text-sm text-zinc-700">
              {report.byCategory.map((category) => (
                <li key={category.category}>
                  {category.category}: {category.qty}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {report.topVariances.length > 0 && (
          <div className="mt-4">
            <h3 className="font-semibold text-zinc-800">Top variances</h3>
            <ul className="text-sm text-zinc-700">
              {report.topVariances.map((variance) => (
                <li key={variance.productId}>
                  {variance.name}: {variance.delta > 0 ? "+" : ""}
                  {variance.delta}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      </BusinessContextGate>
    </div>
  );
}
