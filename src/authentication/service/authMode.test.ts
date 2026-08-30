import { describe, it, expect, afterEach } from "vitest";
import { getAuthMode, isLiveAuth, isOpenAccess } from "./authMode";

const ORIG = { ...process.env };
afterEach(() => {
  process.env.NEXT_PUBLIC_AUTH_MODE = ORIG.NEXT_PUBLIC_AUTH_MODE;
  process.env.NEXT_PUBLIC_REQUIRE_LOGIN = ORIG.NEXT_PUBLIC_REQUIRE_LOGIN;
});

describe("authMode chokepoint", () => {
  it("defaults to mock when nothing is set", () => {
    delete process.env.NEXT_PUBLIC_AUTH_MODE;
    delete process.env.NEXT_PUBLIC_REQUIRE_LOGIN;
    expect(getAuthMode()).toBe("mock");
    expect(isLiveAuth()).toBe(false);
    expect(isOpenAccess()).toBe(true);
  });

  it("is live when NEXT_PUBLIC_AUTH_MODE=live", () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "live";
    expect(getAuthMode()).toBe("live");
    expect(isLiveAuth()).toBe(true);
    expect(isOpenAccess()).toBe(false);
  });

  it("legacy NEXT_PUBLIC_REQUIRE_LOGIN=1 maps to live (back-compat)", () => {
    delete process.env.NEXT_PUBLIC_AUTH_MODE;
    process.env.NEXT_PUBLIC_REQUIRE_LOGIN = "1";
    expect(getAuthMode()).toBe("live");
    expect(isOpenAccess()).toBe(false);
  });

  it("explicit AUTH_MODE wins over the legacy flag", () => {
    process.env.NEXT_PUBLIC_AUTH_MODE = "mock";
    process.env.NEXT_PUBLIC_REQUIRE_LOGIN = "1";
    expect(getAuthMode()).toBe("mock");
  });
});
