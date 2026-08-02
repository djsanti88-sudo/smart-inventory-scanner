"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { ScannerInput } from "@/components/ScannerInput";
import { CameraScanButton } from "@/components/CameraScanButton";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import { FinalCountTable } from "@/components/FinalCountTable";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { ExportMenu } from "@/components/ExportMenu";
import { VarianceReport } from "@/components/VarianceReport";
import { SessionLockControl } from "@/components/SessionLockControl";
import { SessionsList } from "@/components/SessionsList";
import { planScanBatch } from "./planScan";
import { type ScanBatchProgress } from "./runScanBatch";
import { createScanSubmissionQueue } from "./scanSubmissionQueue";
import { resolveRawScan } from "@/services/resolver";
import { computeMoatStats } from "@/services/moatStats";

function ScanPageContent() {
  const searchParams = useSearchParams();
  const processScan = useScanStore((s) => s.processScan);
  const products = useScanStore((s) => s.products);
  const aliases = useScanStore((s) => s.aliases);
  const businessId = useScanStore((s) => s.businessId);
  const startSession = useScanStore((s) => s.startSession);
  const finishSession = useScanStore((s) => s.finishSession);
  const clearSession = useScanStore((s) => s.clearSession);
  const session = useScanStore((s) => s.currentSession);
  const settings = useScanStore((s) => s.settings);
  const aiStatus = useScanStore((s) => s.aiStatus);
  const refreshAiStatus = useScanStore((s) => s.refreshAiStatus);
  const updateSettings = useScanStore((s) => s.updateSettings);
  const categoryWarning = useScanStore((s) => s.lastCategoryWarning);
  const clearCategoryWarning = useScanStore((s) => s.clearCategoryWarning);

  const [name, setName] = useState("");
  const [batchProgress, setBatchProgress] = useState<ScanBatchProgress | null>(null);
  const [queueHolder] = useState(() => {
    const holder: { mounted: boolean; queue?: ReturnType<typeof createScanSubmissionQueue<ReturnType<typeof processScan>>> } = { mounted: true };
    holder.queue = createScanSubmissionQueue({
      processScan,
      chunkSize: 20,
      onBulkStart: (progress) => { if (holder.mounted) setBatchProgress(progress); },
      onBulkProgress: (progress) => { if (holder.mounted) setBatchProgress(progress); },
      onBulkComplete: () => { if (holder.mounted) setBatchProgress(null); },
      onError: ({ code, error }) => console.error(`Bulk scan failed for ${code}.`, error),
    });
    return holder;
  });
  const scanQueue = queueHolder.queue!;
  const location = useScanStore((s) => s.location);
  const setLocation = useScanStore((s) => s.setLocation);
  const recentLocations = useScanStore((s) => s.recentLocations);
  const ensureAutoSession = useScanStore((s) => s.ensureAutoSession);
  const businessContextReady = useScanStore((s) => s.businessContextReady);
  const businessDataLoaded = useScanStore((s) => s.businessDataLoaded);
  const scanFeed = useScanStore((s) => s.scanFeed);
  const firstScanAt = useScanStore((s) => s.firstScanAt);
  const proofBatch = searchParams?.get("proofBatch") ?? null;
  const localDemoProofBatch = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1" && proofBatch && /^(?:0[1-9]|[12][0-9]|30)$/.test(proofBatch)
    ? proofBatch
    : null;

  // BULK SCAN: paste/type several codes separated by spaces or newlines and each becomes its OWN row
  // (one processScan per code). A single hardware-scanned barcode contains no whitespace, so normal
  // one-at-a-time scanning is unchanged. Returns the LAST result so the success panel reflects it.
  //
  // A whitespace-containing string is NOT automatically a multi-code paste: some single codes in this
  // domain legitimately contain an internal space (e.g. a tire part number printed "2881 6861" - one
  // of several separator shapes the resolver already treats as equivalent, see scanCleaner's
  // buildNormalizedCandidates). planScanBatch tries the whole trimmed string as ONE code first (via
  // the same deterministic resolver processScan uses) and only falls back to splitting into N scans
  // when the whole string does not resolve as a single known code.
  const handleScan = (raw: string) => {
    const resolvesAsSingleCode = (code: string) => resolveRawScan(code, products, aliases, businessId).resolverStatus === "known";
    const codes = planScanBatch(raw, resolvesAsSingleCode);
    if (codes.length <= 1) return scanQueue.enqueueSingle(codes[0] ?? raw);
    return scanQueue.enqueueBulk(codes);
  };

  // Learn which provider keys are configured (server-side) so unknown scans can auto-decode.
  // Silent-failure fix (review of 92e9c32c, fix 3b): the mount-time call above is a single attempt -
  // if it fails transiently, stale AI/kill-switch status would otherwise persist for the whole
  // session. A lightweight 60s poll lets a transient failure self-heal without user action; the
  // interval is cleared on unmount so it never leaks past this page.
  useEffect(() => {
    return () => {
      queueHolder.mounted = false;
    };
  }, [queueHolder]);

  useEffect(() => {
    void refreshAiStatus();
    const intervalId = setInterval(() => {
      void refreshAiStatus();
    }, 60_000);
    return () => clearInterval(intervalId);
  }, [refreshAiStatus]);

  useEffect(() => {
    if (!businessContextReady || !businessDataLoaded) return;
    ensureAutoSession();
  }, [businessContextReady, businessDataLoaded, ensureAutoSession]);

  const hasKey = aiStatus.geminiConfigured || aiStatus.openaiConfigured;
  const isPlatform = useIsPlatformOwner(); // AI/provider status is platformOwner-only on the scan page
  // P4: keep the scan box the single hero - collapse the secondary controls by default for real users.
  // Stay expanded under E2E (the auth-bypass flag is set only in the Playwright webServers, never in prod)
  // so tests + power users keep every control reachable.
  const expandSecondary = process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS === "1";
  const autoDecodeOn = settings.aiLookupEnabled && aiStatus.autoDecodeOnScan && aiStatus.liveEnabled && hasKey && !aiStatus.emergencyStop;

  // CATEGORY SELECTOR HIDDEN (owner request, aeb3218 2026-06-25): the dropdown + the "wrong category"
  // warning banner are hidden on this page (code kept - set SHOW_CATEGORY = true to restore them).
  // scanContext itself is NO LONGER force-reset to "any" here: that force-effect silently neutered the
  // documented tire-context auto-count firewall (CLAUDE.md "Master Baseline v1" guardrail #2 - a
  // non-tire result while scanning in Tire context must hard-block auto-count) for every scan, and it
  // made the still-visible Settings > "Scan category" control a dead no-op (it looked functional but
  // was silently overwritten back to "any" the instant /scan re-rendered). scanContext now simply
  // follows settings.scanContext (default "tire" per DEFAULT_SETTINGS, or whatever the shop chose on
  // Settings). Root-caused during the scan-category e2e triage (see
  // .superpowers/sdd/scan-category-triage-report.md).
  const SHOW_CATEGORY = false;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <h1 className="sr-only">Scan</h1>
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4">
        {localDemoProofBatch && (
          <p
            data-testid="local-demo-proof-batch"
            className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900"
          >
            Local demo proof batch {localDemoProofBatch}
          </p>
        )}
        {SHOW_CATEGORY && categoryWarning && (
          <div
            data-testid="category-warning"
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <span>
              {"⚠️"} &ldquo;{categoryWarning.productName}&rdquo; doesn&rsquo;t match your Tires category - sent to Needs Review.
            </span>
            <span className="text-amber-700">Wrong category?</span>
            <button
              type="button"
              data-testid="category-warning-switch"
              onClick={() => {
                updateSettings({ scanContext: "any" });
                clearCategoryWarning();
              }}
              className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
            >
              Switch to Not specialized
            </button>
            <button
              type="button"
              data-testid="category-warning-dismiss"
              onClick={() => clearCategoryWarning()}
              className="ml-auto rounded border border-amber-300 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            >
              Dismiss
            </button>
          </div>
        )}
        {/* C2 first-run banner (GC-D): shown only before this business's first EVER counted scan. Plain,
            passive, non-interactive div - never a modal/overlay, never focusable, never intercepts keys,
            never steals focus from the scanner input. Disappears once a scan exists (feed non-empty or
            firstScanAt set), so it can never linger or block the scan loop. */}
        {scanFeed.length === 0 && firstScanAt == null && (
          <div
            data-testid="first-run-banner"
            className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-base text-blue-900"
          >
            Scan your first barcode to start counting. The scan box is already focused and ready.
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grow">
            <ScannerInput onScan={handleScan} submitMode={settings.scannerSubmitMode} debounceMs={settings.scannerDebounceMs} />
            {batchProgress && (
              <div className="mt-2 flex items-center gap-3">
                <p data-testid="bulk-scan-progress" role="status" aria-live="polite" className="text-sm font-semibold text-blue-800">
                  Processing {batchProgress.processed} of {batchProgress.total} scans...
                </p>
                <button type="button" data-testid="stop-bulk-scan" onClick={() => scanQueue.stopActiveBulk()} className="min-h-11 rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-50">
                  Stop remaining
                </button>
              </div>
            )}
          </div>
          <div className="shrink-0">
            <CameraScanButton onScan={handleScan} />
          </div>
          {SHOW_CATEGORY && (
            <div className="flex flex-col gap-1">
              <label htmlFor="scan-category" className="text-xs font-medium text-zinc-600">
                Scan category
              </label>
              <select
                id="scan-category"
                data-testid="scan-category"
                value={settings.scanContext ?? "any"}
                onChange={(e) => updateSettings({ scanContext: e.target.value as "any" | "tire" })}
                className="rounded border border-zinc-300 px-2 py-1.5 text-sm"
              >
                <option value="tire">Tires</option>
                <option value="any">Not specialized</option>
              </select>
            </div>
          )}
        </div>

        {/* Everything below the scan box is secondary. Group it so the scan box stays the hero. Collapsed by
            default for real users (P4); expanded under E2E so every control stays reachable. */}
        <details open={expandSecondary} className="group mt-1 border-t border-zinc-200 pt-3">
          <summary className="cursor-pointer list-none text-base font-medium text-zinc-700 hover:text-zinc-900">
            <span className="select-none">Sessions and export</span>
          </summary>
        <fieldset disabled={batchProgress !== null} className="m-0 min-w-0 border-0 p-0">
        <div className="mt-3 flex flex-wrap items-center gap-3 text-base">
          <span className="text-zinc-700">
            Session: <strong className="text-zinc-900">{session?.name ?? "None"}</strong>
          </span>
          <input
            aria-label="new session name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New session name"
            className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
          />
          <input
            aria-label="location"
            list="recent-locations"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location (e.g. Bay A)"
            className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
          />
          <datalist id="recent-locations">
            {recentLocations.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </datalist>
          <button
            type="button"
            data-testid="start-session"
            onClick={() => startSession(name || "Session", location)}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700"
          >
            Start new session
          </button>
          <button
            type="button"
            data-testid="finish-session"
            onClick={() => finishSession()}
            disabled={session?.status === "completed"}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            Finish session
          </button>
          <SessionLockControl />
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Clear the current session? Your saved counts are kept - this only starts a fresh, empty session.")) clearSession();
            }}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Clear session
          </button>
          {/* Clear Cache intentionally lives ONLY on Settings - a focused button here would
              capture the scanner's trailing Enter and fire its confirm dialog mid-scan. */}

          {isPlatform && (
            <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
              <span data-testid="auto-decode-status">
                Auto lookup:{" "}
                <strong className={autoDecodeOn ? "text-green-700" : "text-zinc-700"}>
                  {autoDecodeOn ? "On" : "Off"}
                </strong>
              </span>
              <span data-testid="ai-status">Product lookup: {settings.aiLookupEnabled ? "On" : "Off"}</span>
              {settings.aiLookupEnabled && !hasKey && (
                <span className="text-red-700" data-testid="missing-keys">
                  AI keys not set. Auto lookup is disabled.
                </span>
              )}
              <span>
                Lookups today: {settings.dailyLookupCount} of {settings.dailyLookupLimit}
              </span>
            </span>
          )}
        </div>

        <SessionsList />

        <div className="mt-3">
          <SyncStatusBar />
        </div>
        <div className="mt-3">
          <ExportMenu />
        </div>
        </fieldset>
        </details>
      </div>

      {scanFeed.length > 0 && (
        <p className="px-1 text-sm font-medium text-zinc-700" data-testid="moat-line">
          {computeMoatStats(scanFeed).identified} of {computeMoatStats(scanFeed).total} identified automatically
        </p>
      )}
      <LiveScanFeed />
      <FinalCountTable />
      <VarianceReport />
    </div>
  );
}

export default function ScanPage() {
  return (
    <Suspense
      fallback={(
        <div className="mx-auto max-w-7xl p-4" data-testid="scan-page-loading">
          <div className="rounded-lg border border-zinc-200 bg-white p-4 text-base text-zinc-700">
            Loading scanner...
          </div>
        </div>
      )}
    >
      <ScanPageContent />
    </Suspense>
  );
}
