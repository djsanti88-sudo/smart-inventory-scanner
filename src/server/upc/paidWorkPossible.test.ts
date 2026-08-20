import { describe, it, expect } from "vitest";
import { paidWorkPossible, liveAiLookupEnabled } from "./paidWorkPossible";

// `server-only` is aliased to a no-op stub by vitest.config.ts.

const VALID_GTIN = "900000000003"; // 12-digit, valid GS1 check digit (shared fixture pattern with pipeline.test.ts)
const BAD_CHECK_DIGIT_GTIN = "111000222333"; // GTIN-shaped but fails its GS1 check digit
const NON_GTIN = "X001ABC123"; // vendor label shape, not GTIN-shaped at all

// Fake partial env objects, cast the same way aiSpendGuard.test.ts does for its env-parameterized
// functions - only the keys paidWorkPossible actually reads matter for these tests.
const env = (partial: Record<string, string>) => partial as unknown as NodeJS.ProcessEnv;

describe("paidWorkPossible (L6, owner-ratified 2026-07-15)", () => {
  it("returns false when every provider key is absent (a keyless run is free doors + honest skips only)", () => {
    expect(paidWorkPossible(VALID_GTIN, env({}))).toBe(false);
  });

  it("GO_UPC_API_KEY alone -> true, but ONLY for a code with a valid GS1 check digit", () => {
    expect(paidWorkPossible(VALID_GTIN, env({ GO_UPC_API_KEY: "k" }))).toBe(true);
  });

  it("GO_UPC_API_KEY with a BAD-check-digit GTIN and no other keys -> false (Go-UPC cannot pay for this code)", () => {
    expect(paidWorkPossible(BAD_CHECK_DIGIT_GTIN, env({ GO_UPC_API_KEY: "k" }))).toBe(false);
  });

  it("GO_UPC_API_KEY with a NON-GTIN code and no other keys -> false", () => {
    expect(paidWorkPossible(NON_GTIN, env({ GO_UPC_API_KEY: "k" }))).toBe(false);
  });

  it("BRAVE_SEARCH_API_KEY alone -> true (Fetch V2 paid discovery can run), for any code shape", () => {
    expect(paidWorkPossible(NON_GTIN, env({ BRAVE_SEARCH_API_KEY: "k" }))).toBe(true);
  });

  it("FIRECRAWL_API_KEY (legacy single key) alone -> true", () => {
    expect(paidWorkPossible(NON_GTIN, env({ FIRECRAWL_API_KEY: "k" }))).toBe(true);
  });

  it("FIRECRAWL_API_KEY_1 (rotation key) alone -> true", () => {
    expect(paidWorkPossible(NON_GTIN, env({ FIRECRAWL_API_KEY_1: "k" }))).toBe(true);
  });

  it("OPENAI_API_KEY alone -> true (GPT rung can run), for any code shape", () => {
    expect(paidWorkPossible(NON_GTIN, env({ OPENAI_API_KEY: "k" }))).toBe(true);
  });

  it("defaults to process.env when no env override is passed", () => {
    // Smoke check only: must not throw when reading the real process.env.
    expect(typeof paidWorkPossible(VALID_GTIN)).toBe("boolean");
  });
});

describe("liveAiLookupEnabled (ENABLE_LIVE_AI_LOOKUP, enforced server-side since 2026-08-19)", () => {
  it("is on by default and for any value other than the literal \"false\"", () => {
    expect(liveAiLookupEnabled(env({}))).toBe(true);
    expect(liveAiLookupEnabled(env({ ENABLE_LIVE_AI_LOOKUP: "true" }))).toBe(true);
    expect(liveAiLookupEnabled(env({ ENABLE_LIVE_AI_LOOKUP: "0" }))).toBe(true);
  });

  it("ENABLE_LIVE_AI_LOOKUP=false turns paid work OFF even with every provider key configured", () => {
    expect(liveAiLookupEnabled(env({ ENABLE_LIVE_AI_LOOKUP: "false" }))).toBe(false);
    expect(
      paidWorkPossible(VALID_GTIN, env({ ENABLE_LIVE_AI_LOOKUP: "false", GO_UPC_API_KEY: "k", BRAVE_SEARCH_API_KEY: "k", OPENAI_API_KEY: "k" })),
    ).toBe(false);
  });
});
