// Owner PIN lock (client-side deterrent). A single owner PIN locks/unlocks sessions so counts can't be
// opened or edited without it. The PIN is stored ONLY as a salted SHA-256 hash (never plaintext), so it is
// not sitting in plain sight in localStorage. HONEST SCOPE: this deters everyday tampering and accidental
// edits; it is NOT hardened against a determined attacker with browser devtools. Real tamper-proof security
// needs the future server-side login. Pure + dependency-free (Web Crypto), so it is fully unit-testable.

const SALT = "smart-inventory-pin-v1";

/** A valid PIN is 4-6 digits (simple to type on a phone, enough space to deter guessing). */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

/** Salted SHA-256 hash of the PIN, hex-encoded. */
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`${SALT}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** True only when `pin` hashes to the stored `hash`. Empty/absent hash never verifies. */
export async function verifyPin(pin: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !pin) return false;
  return (await hashPin(pin)) === hash;
}
