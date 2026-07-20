// Single source of truth for the coarse auth mode. Collapses the three duplicated reads of
// NEXT_PUBLIC_REQUIRE_LOGIN (AuthGuard.tsx:13, BusinessContextGate.tsx:20, Nav.tsx:50) plus the
// backend flag interplay into one place. ALL THREE consumers must migrate here in the same phase:
// leaving BusinessContextGate on the old read while AuthGuard goes live would raise the login wall
// but keep cloud=false, so business context and per-uid persist would never engage for authed users.
//
//   mock = today's open-demo behavior: no login wall, DEMO_BUSINESS_ID, ai-lookup unauthenticated,
//          global daily cap, e2e/QA-bot substrate untouched. Demos and tests need no credentials.
//   live = auth required: login wall on, membership-derived businessId, ai-lookup authenticated + per-account cap.
//
// Orthogonal (do NOT fold in here): isAuthBypassEnabled() (E2E/test bypass) and
// NEXT_PUBLIC_FIREBASE_USE_EMULATOR (dev-environment selection). Those stay separate on purpose.

export type AuthMode = "mock" | "live";

/**
 * Resolve the auth mode. Precedence:
 *   1. NEXT_PUBLIC_AUTH_MODE=mock|live (explicit, wins).
 *   2. Legacy NEXT_PUBLIC_REQUIRE_LOGIN=1 -> "live" (back-compat so preview/emulator configs keep working).
 *   3. Default "mock".
 */
export function getAuthMode(): AuthMode {
  const explicit = (process.env.NEXT_PUBLIC_AUTH_MODE ?? "").trim().toLowerCase();
  if (explicit === "live" || explicit === "mock") return explicit;
  if (process.env.NEXT_PUBLIC_REQUIRE_LOGIN === "1") return "live";
  return "mock";
}

export function isLiveAuth(): boolean {
  return getAuthMode() === "live";
}

/** Open access = mock mode: no login wall, no business-context gate, demo substrate. */
export function isOpenAccess(): boolean {
  return getAuthMode() === "mock";
}
