"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { useScanStore } from "@/stores/scanStore";
import { useReconcileStore } from "@/stores/reconcileStore";
import { DECODE_BUDGET_MIN_MS, DECODE_BUDGET_MAX_MS, DECODE_BUDGET_DEFAULT_MS } from "@/services/ai/decodeBudget";
import { useIsPlatformOwner } from "@/services/security/useAccessLevel";
import { ExportMenu } from "@/components/ExportMenu";
import { CleanupRecommendations } from "@/components/CleanupRecommendations";
import { OwnerPinSettings } from "@/components/OwnerPinSettings";
import { GptLadderPanel } from "@/components/GptLadderPanel";
import { GeminiStatusRow } from "@/components/GeminiStatusRow";
import { KillSwitchBanner } from "@/components/KillSwitchBanner";
import { requiresOwnerPin } from "@/services/security/destructiveGuard";
import { getSession, onAuthChange } from "@/lib/auth";
import { runSignOutFlow, wipeAndSignOut } from "@/services/auth/signOutFlow";

export default function SettingsPage() {
  const isLocalDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
  const settings = useScanStore((s) => s.settings);
  const update = useScanStore((s) => s.updateSettings);
  const businessId = useScanStore((s) => s.businessId);
  const clearLocalCache = useScanStore((s) => s.clearLocalCache);
  // Spec 3 (M1, clear-cache guard): reuse the store's existing pendingCount() selector rather than
  // re-deriving pendingSyncQueue.length inline.
  const pendingCount = useScanStore((s) => s.pendingCount());
  const aiStatus = useScanStore((s) => s.aiStatus);
  const refreshAiStatus = useScanStore((s) => s.refreshAiStatus);
  const setEmergencyStop = useScanStore((s) => s.setEmergencyStop);
  const catalog = useScanStore((s) => s.catalog);
  // AI/provider + catalog-internals sections are platformOwner-only (customer-facing UI must not expose them).
  const isPlatform = useIsPlatformOwner();

  // Silent-failure fix (review of 92e9c32c, fix 3b): poll refreshAiStatus() every 60s so a transient
  // fetch failure on the mount-time call self-heals instead of leaving stale AI/kill-switch status
  // for the whole session. Interval is cleared on unmount so it never leaks past this page.
  useEffect(() => {
    if (isLocalDemo) return;
    void refreshAiStatus();
    const intervalId = setInterval(() => {
      void refreshAiStatus();
    }, 60_000);
    return () => clearInterval(intervalId);
  }, [isLocalDemo, refreshAiStatus]);

  const verifiedCatalogCount = catalog.filter((e) => e.verificationStatus === "verified").length;
  const pendingCatalogCount = catalog.filter((e) => e.verificationStatus === "pending").length;

  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    if (isLocalDemo) return;
    let active = true;
    getSession().then((s) => {
      if (active) setUser(s);
    });
    const unsub = onAuthChange((s) => {
      if (active) setUser(s);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [isLocalDemo]);

  const [cacheMsg, setCacheMsg] = useState("");
  const [cacheError, setCacheError] = useState("");
  const hasPin = useScanStore((s) => !!s.settings.ownerPinHash);
  const verifyOwnerPin = useScanStore((s) => s.verifyOwnerPin);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState("");

  // The pre-existing clear-cache body, verbatim (AM-R9 preserved). The PIN gate wraps AROUND it.
  async function doClear() {
    const cleared = await clearLocalCache();
    if (cleared && typeof cleared === "object" && !cleared.cleared) {
      setCacheError("We could not safely clear local data. Please try again.");
      return;
    }
    // AM-R9: the reconcile session is browser-local session state too - the same wipe clears it.
    useReconcileStore.getState().clearLocalCache();
    setCacheMsg("Local browser cache cleared. Cloud data was not deleted.");
    setCacheError("");
    // Reload cleanly so cloud data re-loads fresh (and a poisoned alias that returns proves it is in
    // cloud data, to be fixed via the alias repair path, not local cache).
    if (typeof window !== "undefined") setTimeout(() => window.location.reload(), 1400);
    setPinPrompt(false);
    setPin("");
    setPinErr("");
  }

  function handleClearCache() {
    // Spec 3 (M1, clear-cache guard): a generic confirm reads the same whether nothing is at risk or
    // real unsynced work is about to vanish. With pending scans, force a harder-worded confirm that
    // NAMES the exact count so the warning cannot be ignored on autopilot.
    const message =
      pendingCount > 0
        ? `You have ${pendingCount} scan${pendingCount === 1 ? "" : "s"} not yet synced to the ` +
          `cloud. Clearing local cache will PERMANENTLY DISCARD ${pendingCount === 1 ? "it" : "them"} ` +
          `if they have not synced. Continue?`
        : "Clear LOCAL browser cache? This wipes this browser's scan session and local cached data. " +
          "Your cloud data is NOT deleted.";
    const ok = typeof window === "undefined" || window.confirm(message);
    if (!ok) return;
    if (requiresOwnerPin("clearCache", hasPin)) {
      setPinPrompt(true);
      return;
    }
    void doClear();
  }

  async function submitPin() {
    const ok = await verifyOwnerPin(pin);
    if (!ok) { setPinErr("Wrong PIN"); return; }
    await doClear();
  }

  // D2 (Phase 6): hard account deletion. Same owner-PIN gate pattern as clear-cache, plus a typed
  // confirm phrase the server re-checks (client state is never trusted for a destructive action).
  const [deletePrompt, setDeletePrompt] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deletePin, setDeletePin] = useState("");
  const [deleteErr, setDeleteErr] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  function handleDeleteAccount() {
    if (!user) return;
    setDeleteErr("");
    setDeletePhrase("");
    setDeletePin("");
    setDeletePrompt(true);
  }

  async function submitDeleteAccount() {
    if (!user || !businessId) return;
    setDeleteErr("");

    if (requiresOwnerPin("clearCache", hasPin)) {
      const ok = await verifyOwnerPin(deletePin);
      if (!ok) { setDeleteErr("Wrong PIN"); return; }
    }

    if (deletePhrase !== "DELETE MY ACCOUNT") {
      setDeleteErr('Type "DELETE MY ACCOUNT" exactly to confirm.');
      return;
    }

    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        "This permanently deletes every product, count, scan, and setting for this business. " +
          "This cannot be undone. Continue?",
      );
    if (!confirmed) return;

    setDeleteBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId, idToken, confirmPhrase: deletePhrase }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteErr(typeof payload?.error === "string" ? payload.error : "Deletion failed.");
        return;
      }
      setDeletePrompt(false);
      // F2: the business is deleted server-side, so the local tenant blob (scan feed / products /
      // aliases in sis-scan-v1) is now meaningless AND a data leak - without this wipe it ghosts into
      // the next session on this browser. No unsynced-work confirm here: there is nothing to preserve,
      // and the typed-phrase + confirm already gated the destructive act. Same wipe as the sign-out flow.
      await wipeAndSignOut();
      if (typeof window !== "undefined") window.location.href = "/login";
    } catch {
      setDeleteErr("Deletion failed. Check your connection and try again.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="sr-only">Settings</h1>
      <OwnerPinSettings />
      {/* P3: the raw Business ID is an internal identifier - platformOwner only. Customers see only
          Export, Clean up, and Danger zone. */}
      {isPlatform && (
      <Section title="Business">
        <Row label="Business ID">
          <span className="font-mono text-xs text-zinc-600">{businessId}</span>
        </Row>
      </Section>
      )}

      {isPlatform && (<>
      <Section title="AI lookup">
        <Toggle
          label="Enable AI lookup for unknown codes"
          checked={settings.aiLookupEnabled}
          testid="setting-ai-enabled"
          onChange={(v) => update({ aiLookupEnabled: v })}
        />
        <Row label="AI service">
          <select
            value={settings.primaryProvider}
            onChange={(e) => update({ primaryProvider: e.target.value as "mock" | "gemini" | "openai" })}
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-provider"
          >
            <option value="mock">Test mode (free, no key needed)</option>
            <option value="gemini">Fast AI (requires server key)</option>
            <option value="openai">Backup AI (requires server key)</option>
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
          label="Automatically count verified products (no approval needed for high-confidence matches)"
          checked={settings.autoAddDecodedProducts ?? true}
          testid="setting-auto-add"
          onChange={(v) => update({ autoAddDecodedProducts: v })}
        />
        <Row label="Max lookup wait (ms)">
          <input
            type="number"
            min={DECODE_BUDGET_MIN_MS}
            max={DECODE_BUDGET_MAX_MS}
            step={1000}
            value={settings.decodeBudgetMs ?? DECODE_BUDGET_DEFAULT_MS}
            onChange={(e) => update({ decodeBudgetMs: Number(e.target.value) })}
            className="w-24 rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-decode-budget"
          />
        </Row>
        <p className="text-xs text-zinc-500">
          How long a live decode may run before it gives up and routes the code to Needs Review
          (never a partial guess). The server clamps this to between 5000 and 8000 ms.
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
        <Row label="Fast AI lookup">
          <GeminiStatusRow
            geminiConfigured={aiStatus.geminiConfigured}
            geminiUsedForDecode={aiStatus.geminiUsedForDecode}
          />
        </Row>
        <Row label="Backup AI lookup">
          <span className={`text-sm ${aiStatus.openaiConfigured ? "text-green-700" : "text-red-700"}`} data-testid="openai-status">
            {aiStatus.openaiConfigured ? "Connected (key configured)" : "Not connected (key missing)"}
          </span>
        </Row>
        <Row label="Thorough lookup mode">
          <span className="text-sm">{aiStatus.premiumFallback ? "On" : "Off"}</span>
        </Row>
        <GptLadderPanel gptLadder={aiStatus.gptLadder} />
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
        <KillSwitchBanner killSwitchOn={aiStatus.killSwitchOn} statusUnknown={aiStatus.killSwitchStatusUnknown} />
        <Toggle
          label="Emergency stop (pause all AI calls)"
          checked={aiStatus.emergencyStop}
          testid="emergency-stop"
          onChange={(v) => setEmergencyStop(v)}
        />
        {aiStatus.missingKeys.length > 0 && (
          <p className="text-xs text-red-700" data-testid="missing-keys-settings">
            Missing API keys: {aiStatus.missingKeys.join(", ")}. Ask your developer to add these to the
            server configuration, then click Refresh status.
          </p>
        )}
        <button
          type="button"
          data-testid="refresh-ai-status"
          onClick={() => void refreshAiStatus()}
          className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Refresh status
        </button>
      </Section>

      </>)}

      {/* P3: Scanner tuning + Sync internals are technical settings - platformOwner only. A 65+ customer
          should never see "Submit mode", "Debounce (ms)", "pending sync queue", or "idempotent sync". */}
      {isPlatform && (<>
      <Section title="Scanner">
        <Row label="Scanner trigger">
          <select
            value={settings.scannerSubmitMode}
            onChange={(e) => update({ scannerSubmitMode: e.target.value as "enter" | "debounce" | "both" })}
            className="min-h-[44px] rounded-lg border border-zinc-300 px-3 text-sm"
            data-testid="setting-submit-mode"
          >
            <option value="both">Enter key + auto-submit</option>
            <option value="enter">Enter key only</option>
            <option value="debounce">Auto-submit only</option>
          </select>
        </Row>
        <Row label="Auto-submit delay (ms)">
          <input
            type="number"
            min={10}
            value={settings.scannerDebounceMs}
            onChange={(e) => update({ scannerDebounceMs: Number(e.target.value) })}
            className="w-24 min-h-[44px] rounded-lg border border-zinc-300 px-3 text-sm"
          />
        </Row>
      </Section>

      <Section title="Sync">
        <Toggle
          label="Save scans locally when offline"
          checked={settings.enablePendingSyncQueue}
          onChange={(v) => update({ enablePendingSyncQueue: v })}
        />
        <Toggle
          label="Prevent duplicate saves (recommended)"
          checked={settings.enableIdempotentSync}
          onChange={(v) => update({ enableIdempotentSync: v })}
        />
      </Section>
      </>)}

      <Section title="Account">
        {user ? (
          <>
            <Row label="Signed in as">
              <span className="text-sm text-zinc-700" data-testid="account-email">{user.email}</span>
            </Row>
            <button
              type="button"
              data-testid="sign-out"
              // C1: route through the ONE shared sign-out flow (honest unsynced warning + full tenant wipe
              // + signOut + redirect) so this can never drift from Nav's Log out button. A bare signOut()
              // would leave the prior tenant's data in localStorage for the next user on this browser.
              onClick={() => void runSignOutFlow(() => { window.location.href = "/login"; })}
              className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Sign out
            </button>
          </>
        ) : (
          <span className="text-sm text-zinc-600" data-testid="account-local-mode">Local mode (no account)</span>
        )}
      </Section>

      <Section title="Export">
        <ExportMenu />
      </Section>

      {isPlatform && (<>
      <Section title="Smart matching">
        <Toggle
          label="Save verified matches automatically (reduces manual approval work)"
          checked={settings.autoCatalogLearningEnabled ?? true}
          testid="setting-auto-learning"
          onChange={(v) => update({ autoCatalogLearningEnabled: v })}
        />
        <Row label="Minimum confidence to auto-save">
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
        <Row label="Scan context (Tire blocks non-tire products from auto-counting)">
          <select
            value={settings.scanContext ?? "any"}
            onChange={(e) => update({ scanContext: e.target.value as "any" | "tire" })}
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
            data-testid="setting-scan-context"
          >
            <option value="any">Any (multi-trade)</option>
            <option value="tire">Tire inventory</option>
          </select>
        </Row>
        <Toggle
          label="Fast barcode lookup (auto-confirms high-quality matches)"
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

      </>)}

      <Section title="Clean up inventory">
        <CleanupRecommendations />
      </Section>

      <div className="rounded-lg border border-red-200 bg-white p-4">
        <h2 className="mb-1 text-base font-semibold text-red-700">Danger zone</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Clear this browser&apos;s local cache (scan session, learned aliases, pending sync) and
          reload clean demo data. Use this to remove any bad/poisoned mappings. Local only - it does
          not touch production or any external system.
        </p>
        <button
          type="button"
          data-testid="clear-cache"
          onClick={handleClearCache}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-800 hover:bg-red-100"
        >
          Clear local cache
        </button>
        {cacheMsg && (
          <p className="mt-2 text-sm font-medium text-green-700" data-testid="clear-cache-message">
            {cacheMsg}
          </p>
        )}
        {cacheError && (
          <p className="mt-2 text-sm font-medium text-red-700" data-testid="clear-cache-error">
            {cacheError}
          </p>
        )}
        {pinPrompt && (
          <div className="mt-2 flex items-center gap-2" data-testid="clear-cache-pin-row">
            <input aria-label="owner PIN" inputMode="numeric" value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={6}
              placeholder="Owner PIN" data-testid="clear-cache-pin"
              className="min-h-[44px] w-28 rounded-lg border border-zinc-300 px-3 text-base" />
            <button type="button" data-testid="clear-cache-confirm" onClick={submitPin}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-red-600 px-4 text-base font-medium text-white hover:bg-red-700">
              Confirm clear
            </button>
            {pinErr && <span className="text-sm text-red-600" data-testid="clear-cache-pin-error">{pinErr}</span>}
          </div>
        )}

        {!isLocalDemo && <div className="mt-6 border-t border-red-100 pt-4">
          <h3 className="mb-1 text-sm font-semibold text-red-700">Delete account and all data</h3>
          <p className="mb-3 text-xs text-zinc-500">
            Export your data first. Deletion is permanent. This removes every product, count,
            scan, and setting for this business from our servers and cannot be undone.
          </p>
          <button
            type="button"
            data-testid="delete-account"
            onClick={handleDeleteAccount}
            disabled={!user}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete account and all data
          </button>
          {!user && (
            <p className="mt-2 text-xs text-zinc-500" data-testid="delete-account-signin-required">
              Sign in as the business owner to delete this account.
            </p>
          )}
          {deletePrompt && (
            <div className="mt-2 flex flex-col gap-2" data-testid="delete-account-form">
              <label className="text-sm text-zinc-700">
                Type <span className="font-mono font-semibold">DELETE MY ACCOUNT</span> to confirm
              </label>
              <input
                aria-label="confirm deletion phrase"
                value={deletePhrase}
                onChange={(e) => setDeletePhrase(e.target.value)}
                placeholder="DELETE MY ACCOUNT"
                data-testid="delete-account-phrase"
                className="min-h-[44px] w-full max-w-xs rounded-lg border border-zinc-300 px-3 text-base"
              />
              {hasPin && (
                <input
                  aria-label="owner PIN"
                  inputMode="numeric"
                  value={deletePin}
                  onChange={(e) => setDeletePin(e.target.value.replace(/\D/g, ""))}
                  maxLength={6}
                  placeholder="Owner PIN"
                  data-testid="delete-account-pin"
                  className="min-h-[44px] w-28 rounded-lg border border-zinc-300 px-3 text-base"
                />
              )}
              <button
                type="button"
                data-testid="delete-account-confirm"
                onClick={submitDeleteAccount}
                disabled={deleteBusy}
                className="inline-flex min-h-[44px] w-fit items-center rounded-lg bg-red-600 px-4 text-base font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleteBusy ? "Deleting..." : "Permanently delete"}
              </button>
              {deleteErr && (
                <span className="text-sm text-red-600" data-testid="delete-account-error">
                  {deleteErr}
                </span>
              )}
            </div>
          )}
        </div>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="mb-3 text-base font-semibold text-zinc-900">{title}</h2>
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
    <label className="flex cursor-pointer items-center justify-between gap-4">
      <span className="text-sm text-zinc-600">{label}</span>
      <span className="relative inline-flex h-6 w-10">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          data-testid={testid}
          className="peer absolute inset-0 z-10 cursor-pointer opacity-0"
        />
        <span className={`pointer-events-none block h-6 w-10 rounded-full transition-colors peer-focus:ring-2 peer-focus:ring-blue-500 peer-focus:ring-offset-1 ${checked ? "bg-blue-600" : "bg-zinc-300"}`} />
        <span className={`pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
    </label>
  );
}
