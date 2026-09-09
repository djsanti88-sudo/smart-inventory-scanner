"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { BossReportData } from "@/reports/variance/bossReport";

// This public, read-only page intentionally lives outside the authenticated (app) route group.
export default function PublicReportPage() {
  const { token } = useParams<{ token: string }>();
  const [report, setReport] = useState<BossReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? "This link has expired or does not exist.");
        }
        return response.json();
      })
      .then((body) => {
        if (!cancelled) setReport(body.report as BossReportData);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "This link has expired or does not exist.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <main className="mx-auto max-w-lg p-8 text-center">
        <p className="text-lg text-zinc-700" data-testid="share-link-error">
          {error}
        </p>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="mx-auto max-w-lg p-8 text-center">
        <p className="text-zinc-500">Loading report...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <p className="text-lg font-semibold text-emerald-700" data-testid="report-moat-line">
        {report.moat.identified} of {report.moat.total} items identified automatically, no manual entry
      </p>
      <h1 className="text-2xl font-bold text-zinc-900">{report.sessionName}</h1>
      <p className="text-sm text-zinc-600">
        Counted by {report.countedBy} on {new Date(report.countedAt).toLocaleString()}
      </p>
      <p className="text-lg" data-testid="report-total-items">
        Total items: <strong>{report.totalItems}</strong>
      </p>
      {report.hasAnyCostData && report.totalValue !== null && (
        <p className="text-lg" data-testid="report-total-value">
          Estimated value: <strong>${report.totalValue.toFixed(2)}</strong>
        </p>
      )}
    </main>
  );
}
