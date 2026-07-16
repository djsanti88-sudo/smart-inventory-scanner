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
 * EXPLICIT local-mode flag (QA Task 6). When NO cloud backend is configured the app runs open-access /
 * no-login on the platform operator's OWN device (there is no signed-in customer and userId is always
 * null). That runtime is platform-equivalent for PERSISTENCE: it must get the FULL "platform" persist
 * shape - never the customer ("business") strip, which would silently destroy the owner's own data
 * (aliases + product barcodes) on every reload. The signal is the SAME one the store uses to pick its
 * backend (NEXT_PUBLIC_FIREBASE_BACKEND !== "1" -> local mock backend). This is deliberately NOT
 * userId==null: a genuine signed-in customer on a REAL cloud backend still resolves to "business".
 *
 * SCOPE (QA fix 2026-07-15): this flag governs ONLY the persistence access level (persistAccessLevel /
 * buildPersistedScanState). It must NOT be folded into effectiveClientAccessLevel, because that function
 * is ALSO the UI role hint (useAccessLevel). Forcing the UI role to "platform" for every local render
 * defeats the customer role-gating + Model/name customer-sanitization guarantee (a customer-role view
 * would then leak the alias DB and raw un-cleaned identity strings) and made those guarantees
 * unprovable in unit tests. Data survival (persist) and UI role gating are decoupled on purpose.
 */
export function isLocalRuntime(): boolean {
  // Cloud backend configured -> a real (possibly signed-in customer) tenant; NOT local mode.
  if (process.env.NEXT_PUBLIC_FIREBASE_BACKEND === "1") return false;
  // The human-bot E2E suite runs the mock backend but sets NEXT_PUBLIC_E2E_AUTH_BYPASS=1 to SIMULATE a
  // signed-in CUSTOMER on purpose, so it can prove the customer ("business") persist strip + role gating.
  // Honor that: an explicit simulated-customer session is NOT the open-access owner runtime.
  if (process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS === "1") return false;
  return true;
}

/**
 * Client access level honoring the legacy-mock E2E override. The 11 mock Playwright specs exercise the
 * FULL platformOwner view (playwright.config.ts sets NEXT_PUBLIC_E2E_PLATFORM_OWNER=1); the human-bot
 * suite does NOT set it, so it stays a customer ("business"). Real cloud ignores the flag (it is never
 * set there) and uses the actual NEXT_PUBLIC_PLATFORM_OWNER_* allowlist. SINGLE source of truth for the
 * UI ROLE HINT (useAccessLevel) - the customer role gating + Model/name sanitization depend on this
 * returning "business" for a non-platformOwner identity. The local-runtime persist override is applied
 * separately in persistAccessLevel, so data survival never weakens UI customer gating.
 */
export function effectiveClientAccessLevel(identity: Identity): AccessLevel {
  if (process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER === "1") return "platform";
  return accessLevelClient(identity);
}
