import { describe, expect, it } from "vitest";
import { buildDevEnvironment } from "./dev-environment.mjs";

describe("buildDevEnvironment", () => {
  it("sets both browser and Admin SDK emulator context", () => {
    const env = buildDevEnvironment("emulator", {
      NEXT_PUBLIC_FIREBASE_ALLOW_PROD: "1",
      NEXT_PUBLIC_E2E_AUTH_BYPASS: "1",
      FIREBASE_PROJECT_ID: "live-project",
    });

    expect(env).toMatchObject({
      NEXT_PUBLIC_FIREBASE_BACKEND: "1",
      NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "1",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-smart-inventory",
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
      NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST: "127.0.0.1",
      NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT: "8080",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      FIREBASE_PROJECT_ID: "demo-smart-inventory",
      GCLOUD_PROJECT: "demo-smart-inventory",
    });
    expect(env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD).toBeUndefined();
    expect(env.NEXT_PUBLIC_E2E_AUTH_BYPASS).toBeUndefined();
  });

  it("clears inherited emulator routing in deliberate production mode", () => {
    const env = buildDevEnvironment("prod", {
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    });

    expect(env.NEXT_PUBLIC_FIREBASE_ALLOW_PROD).toBe("1");
    expect(env.FIRESTORE_EMULATOR_HOST).toBeUndefined();
    expect(env.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
  });
});
