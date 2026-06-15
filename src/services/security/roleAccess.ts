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
