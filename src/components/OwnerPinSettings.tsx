"use client";

import { useState } from "react";
import { useScanStore } from "@/stores/scanStore";
import { isValidPinFormat } from "@/services/security/pinLock";

// Owner PIN management (Settings). Set / change / reset the single PIN that locks and unlocks sessions.
// The PIN is stored only as a salted hash. Reset clears it AND unlocks every session (forgot-PIN escape).
export function OwnerPinSettings() {
  const hasPin = useScanStore((s) => !!s.settings.ownerPinHash);
  const setOwnerPin = useScanStore((s) => s.setOwnerPin);
  const resetOwnerPin = useScanStore((s) => s.resetOwnerPin);

  const [pin, setPin] = useState("");
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");

  const save = async () => {
    if (!isValidPinFormat(pin)) { setMsg("PIN must be 4-6 digits."); return; }
    const ok = await setOwnerPin(pin);
    setMsg(ok ? "PIN saved." : "PIN must be 4-6 digits.");
    if (ok) { setPin(""); setEditing(false); }
  };

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4" data-testid="owner-pin-settings">
      <h3 className="text-base font-semibold text-zinc-900">Session lock PIN</h3>
      <p className="mt-1 text-sm text-zinc-600">
        Set a PIN to lock a session so its counts can&apos;t be opened or changed without it. Stored as a
        secure hash on this device. A locked session takes no new scans and can&apos;t be edited until unlocked.
      </p>

      {!hasPin || editing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            aria-label="new PIN"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            maxLength={6}
            placeholder="4-6 digit PIN"
            data-testid="pin-input"
            className="min-h-[44px] w-40 rounded-lg border border-zinc-300 px-3 text-base"
          />
          <button type="button" data-testid="pin-save" onClick={save} className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700">
            {hasPin ? "Save new PIN" : "Set PIN"}
          </button>
          {editing && (
            <button type="button" onClick={() => { setEditing(false); setPin(""); setMsg(""); }} className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50">
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-green-100 px-2 py-1 text-sm font-medium text-green-800" data-testid="pin-set-badge">🔒 PIN is set</span>
          <button type="button" data-testid="pin-change" onClick={() => setEditing(true)} className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50">
            Change PIN
          </button>
          <button
            type="button"
            data-testid="pin-reset"
            onClick={() => {
              if (window.confirm("Reset the PIN? This clears it and UNLOCKS every locked session.")) {
                resetOwnerPin();
                setMsg("PIN reset. All sessions unlocked.");
              }
            }}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 bg-red-50 px-4 text-base font-medium text-red-800 hover:bg-red-100"
          >
            Reset PIN
          </button>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-zinc-700" data-testid="pin-msg">{msg}</p>}
    </section>
  );
}
