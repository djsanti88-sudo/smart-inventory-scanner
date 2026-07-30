import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

describe("mock Playwright web-server safety", () => {
  it("shadows live Turso credentials even when the parent shell or .env.local contains them", () => {
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    expect(webServer?.env?.TURSO_DATABASE_URL).toBe("");
    expect(webServer?.env?.TURSO_AUTH_TOKEN).toBe("");
  });
});
