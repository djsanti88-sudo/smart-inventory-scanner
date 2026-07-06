"use client";

import { useEffect, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { ScannerInput } from "@/components/ScannerInput";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import { FinalCountTable } from "@/components/FinalCountTable";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { ExportMenu } from "@/components/ExportMenu";
import { SessionLockControl } from "@/components/SessionLockControl";
import { SessionsList } from "@/components/SessionsList";
import { BusinessContextGate } from "@/components/BusinessContextGate";

export default function ScanPage() {
  const processScan = useScanStore((s) => s.processScan);
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
  const [location, setLocation] = useState("Main");

  // BULK SCAN: paste/type several codes separated by spaces or newlines and each becomes its OWN row
  // (one processScan per code). A single hardware-scanned barcode contains no whitespace, so normal
  // one-at-a-time scanning is unchanged. Returns the LAST result so the success panel reflects it.
  const handleScan = (raw: string) => {
    const codes = raw
      .split(/\s+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length <= 1) return processScan(raw);
    let last = null as ReturnType<typeof processScan>;
    for (const code of codes) last = processScan(code);
    return last;
  };

  // Learn which provider keys are configured (server-side) so unknown scans can auto-decode.
  useEffect(() => {
    void refreshAiStatus();
  }, [refreshAiStatus]);

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
      <BusinessContextGate>
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4">
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
        <div className="flex flex-wrap items-end gap-3">
          <div className="grow">
            <ScannerInput onScan={handleScan} submitMode={settings.scannerSubmitMode} debounceMs={settings.scannerDebounceMs} />
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
          <select
            aria-label="location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-base"
          >
            <option>Main</option>
            <option>Bay A</option>
            <option>Bay B</option>
            <option>Cooler 1</option>
            <option>Warehouse</option>
          </select>
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
        </details>
      </div>

      <LiveScanFeed />
      <FinalCountTable />
      </BusinessContextGate>
    </div>
  );
}
