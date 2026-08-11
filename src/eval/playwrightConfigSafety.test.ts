import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

describe("mock Playwright web-server safety", () => {
  it("limits default Playwright discovery to e2e spec files only", () => {
    expect(config.testDir).toBe("./e2e");
    expect(config.testMatch).toBe("**/*.spec.ts");
    expect(config.testIgnore).toEqual(
      expect.arrayContaining([
        "**/firebase-phase2/**",
        "**/human-bots/**",
        "**/household-decode-test.spec.ts",
        "**/seed.spec.ts",
      ]),
    );
  });

  it("shadows live Turso credentials even when the parent shell or .env.local contains them", () => {
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    expect(webServer?.env?.TURSO_DATABASE_URL).toBe("");
    expect(webServer?.env?.TURSO_AUTH_TOKEN).toBe("");
  });
});
