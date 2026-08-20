// Regression guard for TL-1 (2026-08-13, CRITICAL): model-bakeoff.mjs used to read
// OPENAI_API_KEY/GEMINI_API_KEY straight out of .env.local (the SAME keys the product's live decode
// ladder uses) and fire ~50 real paid calls on a bare `node scripts/model-bakeoff.mjs`, with no flag,
// no confirmation, and no owner gate. That is the exact incident class already recorded in project
// memory ("GPT mini bakeoff 2026-07-26 ... caused real owner charges").
//
// These tests run the REAL script as a subprocess (never mocked away) but never let it reach a
// network call: every scenario below either omits --live (dry run) or fails the key/confirmation gate
// before any fetch() would happen. Nothing here ever talks to a real provider.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "model-bakeoff.mjs");
const SOURCE = readFileSync(SCRIPT, "utf8");

/** Run the real script as a subprocess with a caller-controlled env (never inherits real Lane 2 keys). */
function run(args, envOverrides = {}) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.BAKEOFF_OPENAI_KEY;
  delete env.BAKEOFF_GEMINI_KEY;
  Object.assign(env, envOverrides);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("model-bakeoff.mjs Lane 1 / Lane 2 key separation and cost gate (TL-1)", () => {
  it("never reads .env.local (static source check - the exact defect that caused the prior charge)", () => {
    // Comments/usage text are allowed to mention ".env.local" (to document the Lane 1/Lane 2 rule);
    // what must never exist again is code that opens it. fs is legitimately imported to read the
    // local tire corpus CSV, so assert specifically against reading an env file.
    expect(SOURCE).not.toMatch(/readFileSync\([^)]*\.env/);
  });

  it("only reads keys from BAKEOFF_OPENAI_KEY / BAKEOFF_GEMINI_KEY, never OPENAI_API_KEY / GEMINI_API_KEY", () => {
    expect(SOURCE).toContain("BAKEOFF_OPENAI_KEY");
    expect(SOURCE).toContain("BAKEOFF_GEMINI_KEY");
    // The Lane 2 var names must not appear as a source of secrets for this Lane 1 tool.
    expect(SOURCE).not.toMatch(/process\.env\.OPENAI_API_KEY/);
    expect(SOURCE).not.toMatch(/process\.env\.GEMINI_API_KEY/);
  });

  it("dry-runs by default (no --live): exits 0, spends nothing, prints the plan", () => {
    const result = run(["--count=2"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/DRY RUN/i);
    expect(result.stdout).toMatch(/\$0 spent/);
    expect(result.stdout).toMatch(/worst-case/i);
    // Must not claim a call was made.
    expect(result.stdout).not.toMatch(/ERROR|got size|brand:/i);
  });

  it("bare invocation with no flags at all is also a dry run (the exact TL-1 scenario)", () => {
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/DRY RUN/i);
  });

  it("--live without BAKEOFF_* keys refuses with a Lane 1 / Lane 2 explanation and exits non-zero", () => {
    const result = run(["--live", "--count=1"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/BAKEOFF_OPENAI_KEY/);
    expect(result.stderr).toMatch(/Lane 2/);
  });

  it("--live with keys but without --yes-i-accept-cost still refuses and reports a cost floor", () => {
    const result = run(["--live", "--count=1"], { BAKEOFF_OPENAI_KEY: "fake", BAKEOFF_GEMINI_KEY: "fake" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--yes-i-accept-cost/);
    expect(result.stderr).toMatch(/\$/);
  });
});
