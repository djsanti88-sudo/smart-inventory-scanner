// platformOwner (Santiago) identification. platformOwner is a PLATFORM-LEVEL allowlist, NEVER a business
// membership role. A business role named "owner"/"admin" must never become platformOwner. The allowlist
// is read from env: server-side PLATFORM_OWNER_EMAILS / PLATFORM_OWNER_UIDS (authoritative), and a
// client-visible NEXT_PUBLIC_PLATFORM_OWNER_EMAILS used ONLY to gate UI (server/serializers enforce truth).

export type BusinessRole = "owner" | "admin" | "counter" | "viewer";
export type AccessLevel = "platform" | "business";

export interface Identity {
  email?: string | null;
  uid?: string | null;
}

function parseList(v: string | undefined | null): string[] {
  return (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Pure check: is this identity a platformOwner per the given allowlists? Email match or UID match. */
export function isPlatformOwnerIdentity(identity: Identity, allow: { emails: string[]; uids: string[] }): boolean {
  const email = (identity.email ?? "").trim().toLowerCase();
  const uid = (identity.uid ?? "").trim().toLowerCase();
  if (email && allow.emails.includes(email)) return true;
  if (uid && allow.uids.includes(uid)) return true;
  return false;
}

/** Server-side authoritative check (reads non-public env). Use in API routes / server actions. */
export function isPlatformOwnerServer(identity: Identity): boolean {
  return isPlatformOwnerIdentity(identity, {
    emails: parseList(process.env.PLATFORM_OWNER_EMAILS),
    uids: parseList(process.env.PLATFORM_OWNER_UIDS),
  });
}

/** Client-side UI hint only (reads NEXT_PUBLIC_*). Never the source of truth for data access. */
export function isPlatformOwnerClient(identity: Identity): boolean {
  return isPlatformOwnerIdentity(identity, {
    emails: parseList(process.env.NEXT_PUBLIC_PLATFORM_OWNER_EMAILS),
    uids: parseList(process.env.NEXT_PUBLIC_PLATFORM_OWNER_UIDS),
  });
}

/** Map an identity to an access level. platformOwner -> "platform" (full); everyone else -> "business". */
export function accessLevelServer(identity: Identity): AccessLevel {
  return isPlatformOwnerServer(identity) ? "platform" : "business";
}
export function accessLevelClient(identity: Identity): AccessLevel {
  return isPlatformOwnerClient(identity) ? "platform" : "business";
}

/**
 * Client access level honoring the legacy-mock E2E override. The 11 mock Playwright specs exercise the
 * FULL platformOwner view (playwright.config.ts sets NEXT_PUBLIC_E2E_PLATFORM_OWNER=1); the human-bot
 * suite does NOT set it, so it stays a customer ("business"). Real cloud ignores the flag (it is never
 * set there) and uses the actual NEXT_PUBLIC_PLATFORM_OWNER_* allowlist. SINGLE source of truth shared
 * by the React hook (useAccessLevel) and the store persist split (Sec-4 partialize), so they never drift.
 */
export function effectiveClientAccessLevel(identity: Identity): AccessLevel {
  if (process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER === "1") return "platform";
  return accessLevelClient(identity);
}
