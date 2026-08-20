import { describe, expect, it } from "vitest";
import mockConfig from "../../playwright.config";
import firebaseConfig from "../../playwright.firebase.config";
import botsConfig from "../../playwright.bots.config";
import { localE2EWebServerEnv } from "../../e2e/localWebServerEnv";

const configs = [
  ["mock E2E", mockConfig],
  ["Firebase emulator E2E", firebaseConfig],
  ["QA bots", botsConfig],
] as const;

describe("local Playwright web-server safety", () => {
  it("scrubs inherited alternate Turso/libsql connection names before spawning a child server", () => {
    const env = localE2EWebServerEnv(
      "contract",
      {},
      {
        PROMOTE_TURSO_URL: "libsql://production.example",
        CUSTOM_LIBSQL_TOKEN: "production-secret",
        SAFE_LOCAL_FLAG: "kept",
      },
    );

    expect(env.PROMOTE_TURSO_URL).toBe("");
    expect(env.CUSTOM_LIBSQL_TOKEN).toBe("");
    expect(env.SAFE_LOCAL_FLAG).toBe("kept");
  });

  it.each(configs)("%s scrubs every Turso/libsql URL and token and pins test-local ladder storage", (_, config) => {
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    const env = webServer?.env ?? {};
    expect(env.IS_E2E).toBe("1");
    expect(env.TURSO_DATABASE_URL).toBe("");
    expect(env.TURSO_AUTH_TOKEN).toBe("");
    expect(env.LIBSQL_URL).toBe("");
    expect(env.LIBSQL_AUTH_TOKEN).toBe("");
    expect(env.BOSS_CORPUS_LADDER_STORAGE_DIR?.replaceAll("\\", "/")).toMatch(
      /\/\.playwright\/e2e-ladder-storage\//,
    );

    for (const [key, value] of Object.entries(env)) {
      if (/(?:TURSO|LIBSQL).*(?:URL|TOKEN)|(?:URL|TOKEN).*(?:TURSO|LIBSQL)/i.test(key)) {
        expect(value, `${key} must be scrubbed`).toBe("");
      }
    }
  });
});
