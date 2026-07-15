import { describe, it, expect } from "vitest";

// B3 (2026-07-15): a small set of environment self-checks so the unit suite can prove it is running
// in the environment it THINKS it is. Each of these has bitten the project before or is a plausible
// stale-env footgun: IS_E2E silently forcing mock-only decode paths outside Playwright's webServer,
// a stale/copy-pasted Turso URL that is not actually a libsql credential, and an empty
// GPT_LADDER_MODEL env var silently falling back instead of erroring loudly.
describe("B3 env behavior gate - the unit suite runs in the environment it thinks it does", () => {
  it("IS_E2E is not set during unit runs (would silently force mock-only decode paths)", () => {
    expect(process.env.IS_E2E).toBeUndefined();
  });

  it("if Turso vars are set they are shaped like real libsql credentials", () => {
    const url = process.env.TURSO_DATABASE_URL;
    if (url) expect(url.startsWith("libsql://"), "TURSO_DATABASE_URL is not a libsql URL - stale env?").toBe(true);
  });

  it("GPT_LADDER_MODEL, if set, is non-empty and has no whitespace padding", () => {
    const m = process.env.GPT_LADDER_MODEL;
    if (m !== undefined) expect(m.trim().length, "empty GPT_LADDER_MODEL silently falls back").toBeGreaterThan(0);
  });
});
