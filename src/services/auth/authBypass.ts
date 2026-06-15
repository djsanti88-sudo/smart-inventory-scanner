// Pure E2E/test auth-bypass gate (guardrail 4). No imports -> node-testable in the `unit` vitest project.
// IMPOSSIBLE in production: NODE_ENV === "production" short-circuits to false before any flag is read.

export function isAuthBypassEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  // Node/test context (vitest sets NODE_ENV=test): the literal guardrail condition.
  if (process.env.NODE_ENV === "test") return process.env.IS_E2E === "1";
  // Browser dev context (Playwright runs `next dev`; the server-only IS_E2E isn't in the client bundle
  // and client NODE_ENV is "development"): require an explicit public flag we set ONLY in the Playwright
  // webServer env. Still impossible in production because of the guard above.
  return process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS === "1";
}
