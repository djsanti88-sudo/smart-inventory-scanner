"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";

// Owner-PIN lock control for the current session. Locked = read-only (no new scans, no edits) until the
// owner PIN unlocks it. When no PIN is set yet, the Lock button points the owner to Settings.
export function SessionLockControl() {
  const session = useScanStore((s) => s.currentSession);
  const hasPin = useScanStore((s) => !!s.settings.ownerPinHash);
  const lockSession = useScanStore((s) => s.lockSession);
  const unlockSession = useScanStore((s) => s.unlockSession);

  const [entering, setEntering] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");

  if (!session) return null;

  if (session.locked) {
    return (
      <div className="flex items-center gap-2" data-testid="session-lock">
        <span className="rounded-md bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">🔒 Locked</span>
        {entering ? (
          <>
            <input
              aria-label="unlock PIN"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              maxLength={6}
              placeholder="PIN"
              data-testid="unlock-pin"
              className="min-h-[44px] w-24 rounded-lg border border-zinc-300 px-3 text-base"
            />
            <button
              type="button"
              data-testid="unlock-submit"
              onClick={async () => {
                const ok = await unlockSession(session.id, pin);
                if (ok) { setEntering(false); setPin(""); setErr(""); } else setErr("Wrong PIN");
              }}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700"
            >
              Unlock
            </button>
            {err && <span className="text-sm text-red-600" data-testid="unlock-error">{err}</span>}
          </>
        ) : (
          <button
            type="button"
            data-testid="unlock-open"
            onClick={() => setEntering(true)}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Unlock
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="lock-session"
      disabled={!hasPin}
      title={hasPin ? "Lock this session so its counts can't change without your PIN" : "Set an owner PIN in Settings first"}
      onClick={() => lockSession(session.id)}
      className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
    >
      🔒 Lock session
    </button>
  );
}
