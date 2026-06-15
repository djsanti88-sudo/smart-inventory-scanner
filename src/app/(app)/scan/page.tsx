"use client";

import { useEffect, useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { ScannerInput } from "@/components/ScannerInput";
import { LiveScanFeed } from "@/components/LiveScanFeed";
import { FinalCountTable } from "@/components/FinalCountTable";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { ExportButtons } from "@/components/ExportButtons";

export default function ScanPage() {
  const processScan = useScanStore((s) => s.processScan);
  const startSession = useScanStore((s) => s.startSession);
  const clearSession = useScanStore((s) => s.clearSession);
  const session = useScanStore((s) => s.currentSession);
  const settings = useScanStore((s) => s.settings);
  const aiStatus = useScanStore((s) => s.aiStatus);
  const refreshAiStatus = useScanStore((s) => s.refreshAiStatus);

  const [name, setName] = useState("");
  const [location, setLocation] = useState("Main");

  // Learn which provider keys are configured (server-side) so unknown scans can auto-decode.
  useEffect(() => {
    void refreshAiStatus();
  }, [refreshAiStatus]);

  const hasKey = aiStatus.geminiConfigured || aiStatus.openaiConfigured;
  const autoDecodeOn = settings.aiLookupEnabled && aiStatus.autoDecodeOnScan && aiStatus.liveEnabled && hasKey && !aiStatus.emergencyStop;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4">
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grow">
            <ScannerInput onScan={(raw) => processScan(raw)} submitMode={settings.scannerSubmitMode} debounceMs={settings.scannerDebounceMs} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-zinc-600">
            Session: <strong className="text-zinc-900">{session?.name ?? "None"}</strong>
          </span>
          <input
            aria-label="new session name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New session name"
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
          />
          <select
            aria-label="location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
          >
            <option>Main</option>
            <option>Bay A</option>
            <option>Bay B</option>
            <option>Cooler 1</option>
            <option>Warehouse</option>
          </select>
          <button
            type="button"
            onClick={() => startSession(name || "Session", location)}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Start new session
          </button>
          <button
            type="button"
            onClick={() => clearSession()}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Clear session
          </button>
          {/* Clear Cache intentionally lives ONLY on Settings - a focused button here would
              capture the scanner's trailing Enter and fire its confirm dialog mid-scan. */}

          <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
            <span data-testid="auto-decode-status">
              Auto decode on scan:{" "}
              <strong className={autoDecodeOn ? "text-green-700" : "text-zinc-700"}>
                {autoDecodeOn ? "On" : "Off"}
              </strong>
            </span>
            <span data-testid="ai-status">AI lookup: {settings.aiLookupEnabled ? "On" : "Off"}</span>
            {settings.aiLookupEnabled && !hasKey && (
              <span className="text-red-600" data-testid="missing-keys">
                Missing keys: {aiStatus.missingKeys.join(", ") || "GEMINI_API_KEY, OPENAI_API_KEY"}
              </span>
            )}
            <span>
              Daily lookups: {settings.dailyLookupCount}/{settings.dailyLookupLimit}
            </span>
          </span>
        </div>

        <SyncStatusBar />
        <ExportButtons />
      </div>

      <LiveScanFeed />
      <FinalCountTable />
    </div>
  );
}
