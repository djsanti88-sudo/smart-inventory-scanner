import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { isAuthBypassEnabled } from "@/authentication/service/authBypass";

// Guardrail 4 proof: the E2E/test auth bypass can NEVER activate in production, and only activates under
// the intended test/e2e conditions.

const ORIG = { NODE_ENV: process.env.NODE_ENV, IS_E2E: process.env.IS_E2E, PUB: process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS };

function setEnv(nodeEnv: string | undefined, isE2E: string | undefined, pub: string | undefined) {
  if (nodeEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
  else (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (isE2E === undefined) delete process.env.IS_E2E;
  else process.env.IS_E2E = isE2E;
  if (pub === undefined) delete process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS;
  else process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS = pub;
}

beforeEach(() => setEnv(ORIG.NODE_ENV, ORIG.IS_E2E, ORIG.PUB));
afterEach(() => setEnv(ORIG.NODE_ENV, ORIG.IS_E2E, ORIG.PUB));

describe("isAuthBypassEnabled (must be impossible in production)", () => {
  it("is FALSE in production even if every bypass flag is set", () => {
    setEnv("production", "1", "1");
    expect(isAuthBypassEnabled()).toBe(false);
  });

  it("is TRUE in test mode with IS_E2E=1 (the literal guardrail condition)", () => {
    setEnv("test", "1", undefined);
    expect(isAuthBypassEnabled()).toBe(true);
  });

  it("is FALSE in test mode without IS_E2E", () => {
    setEnv("test", undefined, undefined);
    expect(isAuthBypassEnabled()).toBe(false);
  });

  it("is FALSE in test mode when IS_E2E is not exactly '1'", () => {
    setEnv("test", "0", "1");
    expect(isAuthBypassEnabled()).toBe(false);
  });

  it("activates in dev only with the explicit public e2e flag (browser/Playwright path)", () => {
    setEnv("development", undefined, "1");
    expect(isAuthBypassEnabled()).toBe(true);
    setEnv("development", undefined, undefined);
    expect(isAuthBypassEnabled()).toBe(false);
  });
});
