// THE ONLY SANCTIONED WAY a Lane 1 dev-tooling script (anything under scripts/) may obtain a
// provider key and permission to spend real money. Born from the 2026-07-26 incident
// (a retired experiment read .env.local's OPENAI_API_KEY on a bare invocation and fired many
// live paid calls with no flag, causing a real owner charge) and finding TL2-1 (2026-08-13), which
// found 9 sibling scripts doing the identical unguarded thing, plus 3 more found re-verifying that
// list (scripts/paidScriptGuard.enforcement.test.mjs is what makes the NEXT sibling impossible to
// add silently).
//
// Project policy: dev tooling must never read the app runtime's OPENAI_API_KEY. That key belongs
// exclusively to the app decoder, which
// has its own cap/breaker/kill-switch). This module is how a Lane 1 script complies without
// reinventing the pattern every time.
//
// Contract:
//   1. This module itself NEVER reads .env.local. Keys come ONLY from explicitly-named
//      dev-tooling env vars the owner sets deliberately for a specific script/run (e.g.
//      SCRIPT_OPENAI_KEY) - never the app runtime's own
//      OPENAI_API_KEY/GEMINI_API_KEY/GO_UPC_API_KEY/FIRECRAWL_API_KEY/BRAVE_SEARCH_API_KEY names.
//   2. Callers default to a DRY RUN: requireLiveApproval() prints what WOULD run plus a worst-case
//      cost FLOOR, spends $0, and exits 0 unless --live is passed.
//   3. Requires BOTH --live AND --yes-i-accept-cost before any live call is permitted (flags, never
//      an interactive prompt - this tooling runs non-interactively and a prompt would hang).
//   4. Reports cost as a computed FLOOR only (Paid API Cost Truth Rule, CLAUDE.md): true spend must
//      be read from the provider's own billing console, never presented as a final number.
//
// This guard remains generic so a retired provider cannot be reintroduced through an unguarded script.
//
// Usage:
//   import { requireLiveApproval, requireDevToolingKey } from "./lib/paidScriptGuard.mjs";
//   const approval = requireLiveApproval({ worstCaseFloorUsd: 2.5, describe: () => "..." });
//   if (!approval.live) return; // dry run already printed + exited 0 inside requireLiveApproval
//   const key = requireDevToolingKey("SCRIPT_OPENAI_KEY");

const LANE2_KEY_NAMES = /^(OPENAI|GEMINI|GO_UPC|FIRECRAWL|BRAVE_SEARCH)_API_KEY$/;

export function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

export function argValue(name, fallback, argv = process.argv) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

/**
 * Gate a live paid run behind --live AND --yes-i-accept-cost.
 *
 * Without --live: prints a DRY RUN report (via `describe`, if given) plus the worst-case cost
 * floor, spends $0, and exits the process with code 0. Returns { live: false } (unreachable in
 * practice since `exit` terminates the process, but kept for testability when `exit` is stubbed).
 *
 * With --live but no --yes-i-accept-cost: prints the floor and exits 1.
 *
 * Only returns { live: true } when both flags are present.
 */
export function requireLiveApproval({ worstCaseFloorUsd = 0, describe, argv = process.argv, exit = process.exit, log = console.log, err = console.error } = {}) {
  const live = hasFlag("live", argv);
  const accept = hasFlag("yes-i-accept-cost", argv);
  const floorLine = `Computed worst-case cost FLOOR: $${Number(worstCaseFloorUsd).toFixed(3)} - this is a FLOOR, not a final number (Paid API Cost Truth Rule); true spend must be read from the provider's own billing console.`;

  if (!live) {
    log("DRY RUN - no calls made, $0 spent.\n");
    if (typeof describe === "function") log(describe());
    log(`\n${floorLine}`);
    log("\nTo actually run this and spend real money:");
    log("  1. Set the dev-tooling-only key env var(s) this script documents (NEVER .env.local - that");
    log("     file's provider keys belong exclusively to Lane 2, the app runtime's decode ladder, per");
    log("     CLAUDE.md's Delegation Model Policy).");
    log("  2. Re-run with both --live and --yes-i-accept-cost.");
    exit(0);
    return { live: false };
  }
  if (!accept) {
    err("--live requires --yes-i-accept-cost as well (no interactive prompt - this tooling runs non-interactively).");
    err(floorLine);
    exit(1);
    return { live: false };
  }
  return { live: true };
}

/**
 * Read ONE dev-tooling-only key from process.env - NEVER from .env.local. Exits 1 with a clear
 * explanation if missing, or if `varName` is one of the app runtime's own Lane 2 key names (a
 * dev script must use a separately-named var, e.g. BAKEOFF_OPENAI_KEY, so it can never silently
 * pick up the real .env.local value even if something upstream already exported it).
 */
export function requireDevToolingKey(varName, { exit = process.exit, err = console.error } = {}) {
  if (LANE2_KEY_NAMES.test(varName)) {
    err(`Refusing to read '${varName}': that is the app runtime's own Lane 2 key name.`);
    err("Dev tooling must use a separately-named var (e.g. BAKEOFF_OPENAI_KEY) so it can never silently");
    err("pick up the real .env.local value. See CLAUDE.md's Delegation Model Policy.");
    exit(1);
    return "";
  }
  const value = process.env[varName];
  if (!value) {
    err(`Missing ${varName}.`);
    err("This guard never reads .env.local: that file's provider keys belong exclusively to Lane 2 (the");
    err("app runtime's decode ladder) per CLAUDE.md's Delegation Model Policy. Set");
    err(`${varName} deliberately for this Lane 1 dev-tooling run, or omit --live for a $0 dry run.`);
    exit(1);
    return "";
  }
  return value;
}
