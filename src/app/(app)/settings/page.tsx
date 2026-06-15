"use client";

import { useEffect } from "react";
import { useScanStore } from "@/stores/scanStore";
import { ExportButtons } from "@/components/ExportButtons";
import { CleanupRecommendations } from "@/components/CleanupRecommendations";

export default function SettingsPage() {
  const settings = useScanStore((s) => s.settings);
  const update = useScanStore((s) => s.updateSettings);
  const businessId = useScanStore((s) => s.businessId);
  const clearLocalCache = useScanStore((s) => s.clearLocalCache);
  const aiStatus = useScanStore((s) => s.aiStatus);
  const refreshAiStatus = useScanStore((s) => s.refreshAiStatus);
  const setEmergencyStop = useScanStore((s) => s.setEmergencyStop);
  const catalog = useScanStore((s) => s.catalog);

  useEffect(() => {
    void refreshAiStatus();
  }, [refreshAiStatus]);

  const verifiedCatalogCount = catalog.filter((e) => e.verificationStatus === "verified").length;
  const pendingCatalogCount = catalog.filter((e) => e.verificationStatus === "pending").length;

  function handleClearCache() {
    const ok =
      typeof window === "undefined" ||
      window.confirm(
        "Clear local cache? This wipes this browser's scan session, learned aliases, and pending " +
          "sync, then reloads clean demo data. It does NOT touch any production or external system.",
      );
    if (ok) clearLocalCache();
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <Section title="Business">
        <Row label="Business ID">
          <span className="font-mono text-xs text-zinc-600">{businessId}</span>
        </Row>
      </Section>

      <Section title="AI lookup">
        <Toggle
          label="Enable AI lookup for unknown codes"
          checked={settings.aiLookupEnabled}
          testid="setting-ai-enabled"
          onChange={(v) => update({ aiLookupEnabled: v })}
        />
        <Row label="Primary provider">
          <select
            value={settings.primaryProvider}
            onChange={(e) => update({ primaryProvider: e.target.value as "mock" | "gemini" | "openai" })}
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-provider"
          >
            <option value="mock">Mock (local, free)</option>
            <option value="gemini">Gemini (requires key, server-side)</option>
            <option value="openai">OpenAI (requires key, server-side)</option>
          </select>
        </Row>
        <Row label="Daily lookup limit">
          <input
            type="number"
            min={0}
            value={settings.dailyLookupLimit}
            onChange={(e) => update({ dailyLookupLimit: Number(e.target.value) })}
            className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-daily-limit"
          />
        </Row>
        <Row label="Daily lookups used">
          <span className="text-sm text-zinc-600">
            {settings.dailyLookupCount}/{settings.dailyLookupLimit}
          </span>
        </Row>
        <Toggle
          label="Auto-suggest for unknown codes (AI runs automatically, suggestion only)"
          checked={settings.autoSuggestUnknowns ?? false}
          testid="setting-auto-suggest"
          onChange={(v) => update({ autoSuggestUnknowns: v })}
        />
        <Toggle
          label="Auto-add decoded products to the count (verified + sourced suggestions)"
          checked={settings.autoAddDecodedProducts ?? true}
          testid="setting-auto-add"
          onChange={(v) => update({ autoAddDecodedProducts: v })}
        />
        <Row label="AI decode time budget (ms)">
          <input
            type="number"
            min={5000}
            max={20000}
            step={1000}
            value={settings.decodeBudgetMs ?? 13000}
            onChange={(e) => update({ decodeBudgetMs: Number(e.target.value) })}
            className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-decode-budget"
          />
        </Row>
        <p className="text-xs text-zinc-500">
          How long a live decode may run before it gives up and routes the code to Needs Review
          (never a partial guess). The server clamps this to between 5000 and 20000 ms.
        </p>
        <p className="text-xs text-zinc-500">
          AI results are SUGGESTIONS a human approves. Even a &quot;Verified AI Decode&quot; (the app
          independently confirmed the exact code in real evidence and providers agreed) needs your
          approval unless you turn on auto-accept above. AI never creates a product, saves an alias,
          or counts on its own otherwise. Vendor/Amazon/internal codes can never be auto-verified.
        </p>
        <Toggle
          label="Allow AI image suggestions"
          checked={settings.allowImageSuggestions}
          onChange={(v) => update({ allowImageSuggestions: v })}
        />
        <p className="text-xs text-zinc-500">
          Real providers run server-side only and never see raw customer, employee, or pricing data
          (a sanitizer masks it first). With no key configured, the app stays on the mock provider.
        </p>
      </Section>

      <Section title="Live AI status">
        <Row label="Mode">
          <span className="text-sm text-zinc-700" data-testid="ai-mode">{aiStatus.mode}</span>
        </Row>
        <Row label="Auto decode on scan">
          <span className="text-sm">{aiStatus.autoDecodeOnScan ? "On" : "Off"}</span>
        </Row>
        <Row label="Gemini live lookup">
          <span className={`text-sm ${aiStatus.geminiConfigured ? "text-green-700" : "text-red-600"}`} data-testid="gemini-status">
            {aiStatus.geminiConfigured ? "On (key configured)" : "Missing GEMINI_API_KEY"}
          </span>
        </Row>
        <Row label="OpenAI live lookup">
          <span className={`text-sm ${aiStatus.openaiConfigured ? "text-green-700" : "text-red-600"}`} data-testid="openai-status">
            {aiStatus.openaiConfigured ? "On (key configured)" : "Missing OPENAI_API_KEY"}
          </span>
        </Row>
        <Row label="Premium fallback">
          <span className="text-sm">{aiStatus.premiumFallback ? "On" : "Off"}</span>
        </Row>
        <Row label="Daily lookup count">
          <span className="text-sm text-zinc-600">
            {settings.dailyLookupCount}/{settings.dailyLookupLimit}
          </span>
        </Row>
        <Row label="Last decode attempt">
          <span className="text-sm text-zinc-600">{aiStatus.lastAttemptAt ?? "none yet"}</span>
        </Row>
        <Row label="Last provider used">
          <span className="text-sm text-zinc-600">{aiStatus.lastProvider || "none yet"}</span>
        </Row>
        <Row label="Last failure reason">
          <span className="text-sm text-zinc-600" data-testid="last-failure">{aiStatus.lastFailureReason || "none"}</span>
        </Row>
        <Toggle
          label="Emergency stop (pause all AI calls)"
          checked={aiStatus.emergencyStop}
          testid="emergency-stop"
          onChange={(v) => setEmergencyStop(v)}
        />
        {aiStatus.missingKeys.length > 0 && (
          <p className="text-xs text-red-600" data-testid="missing-keys-settings">
            Missing keys: {aiStatus.missingKeys.join(", ")}. Add them to .env.local (server-side only)
            and restart the dev server, then click Refresh.
          </p>
        )}
        <button
          type="button"
          data-testid="refresh-ai-status"
          onClick={() => void refreshAiStatus()}
          className="w-fit rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Refresh status
        </button>
      </Section>

      <Section title="Scanner">
        <Row label="Submit mode">
          <select
            value={settings.scannerSubmitMode}
            onChange={(e) => update({ scannerSubmitMode: e.target.value as "enter" | "debounce" | "both" })}
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-submit-mode"
          >
            <option value="both">Enter + debounce</option>
            <option value="enter">Enter only</option>
            <option value="debounce">Debounce only</option>
          </select>
        </Row>
        <Row label="Debounce (ms)">
          <input
            type="number"
            min={10}
            value={settings.scannerDebounceMs}
            onChange={(e) => update({ scannerDebounceMs: Number(e.target.value) })}
            className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm"
          />
        </Row>
      </Section>

      <Section title="Sync">
        <Toggle
          label="Enable pending sync queue"
          checked={settings.enablePendingSyncQueue}
          onChange={(v) => update({ enablePendingSyncQueue: v })}
        />
        <Toggle
          label="Enable idempotent sync"
          checked={settings.enableIdempotentSync}
          onChange={(v) => update({ enableIdempotentSync: v })}
        />
      </Section>

      <Section title="Export">
        <ExportButtons />
      </Section>

      <Section title="Auto-catalog learning">
        <Toggle
          label="Auto-save strong matches to the verified catalog (fewer manual approvals)"
          checked={settings.autoCatalogLearningEnabled ?? true}
          testid="setting-auto-learning"
          onChange={(v) => update({ autoCatalogLearningEnabled: v })}
        />
        <Row label="Auto-save confidence threshold">
          <input
            type="number"
            min={70}
            max={95}
            step={5}
            value={settings.autoVerifyConfidenceThreshold ?? 80}
            onChange={(e) => update({ autoVerifyConfidenceThreshold: Number(e.target.value) })}
            className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-auto-threshold"
          />
        </Row>
        <Toggle
          label="Trusted-source fast path (Tier 1/2 exact barcode auto-verifies)"
          checked={settings.trustedSourceAutoVerifyEnabled ?? true}
          testid="setting-trusted-source"
          onChange={(v) => update({ trustedSourceAutoVerifyEnabled: v })}
        />
        <Toggle
          label="Allow AI-only auto-verify (not recommended)"
          checked={settings.aiOnlyAutoVerifyAllowed ?? false}
          testid="setting-ai-only"
          onChange={(v) => update({ aiOnlyAutoVerifyAllowed: v })}
        />
        <p className="text-xs text-zinc-500">
          Strong, evidence-backed scans (exact barcode on a trusted source, score at or above the
          threshold, no conflict) save to the verified catalog automatically and count with no
          approval. Weak, conflicting, unsafe, or AI-only-without-evidence results always go to Needs
          Review. Safety gates always apply, so lowering the threshold can never auto-save a conflict
          or unsafe result.
        </p>
      </Section>

      <Section title="Shared barcode catalog">
        <Row label="Verified entries">
          <span className="text-sm text-zinc-700" data-testid="catalog-status">{verifiedCatalogCount}</span>
        </Row>
        <Row label="Pending entries">
          <span className="text-sm text-zinc-600">{pendingCatalogCount}</span>
        </Row>
        <p className="text-xs text-zinc-500">
          Catalog-first lookup: a verified entry resolves a scan with no AI call (shop overrides win
          over the global catalog). Local-only for now; a cloud database can be added later behind the
          same abstraction. The global catalog stores only sanitized barcode/product/evidence data -
          never shop, customer, or pricing data.
        </p>
      </Section>

      <Section title="Clean up inventory">
        <CleanupRecommendations />
      </Section>

      <div className="rounded-lg border border-red-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-red-700">Danger zone</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Clear this browser&apos;s local cache (scan session, learned aliases, pending sync) and
          reload clean demo data. Use this to remove any bad/poisoned mappings. Local only - it does
          not touch production or any external system.
        </p>
        <button
          type="button"
          data-testid="clear-cache"
          onClick={handleClearCache}
          className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Clear local cache
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-zinc-800">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-zinc-600">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  testid,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testid?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-sm text-zinc-600">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
    </label>
  );
}
