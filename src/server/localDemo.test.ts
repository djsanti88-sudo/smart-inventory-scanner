import { afterEach, describe, expect, it } from "vitest";
import { buildPersistedScanState } from "@/stores/scanPersist";
import { isLiveAuth } from "@/services/auth/authMode";
import { isLocalRuntime } from "@/services/security/roleAccess";
import { buildLocalDemoEnvironment } from "../../scripts/local-demo-environment.mjs";
import { isLocalDemo } from "./localDemo";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe("isLocalDemo", () => {
  it("is enabled only by the explicit value 1", () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    expect(isLocalDemo()).toBe(true);
    process.env.SCANBIN_LOCAL_DEMO = "true";
    expect(isLocalDemo()).toBe(false);
    delete process.env.SCANBIN_LOCAL_DEMO;
    expect(isLocalDemo()).toBe(false);
  });

  it("pins mock auth and preserves the complete local persistence shape after serialization", () => {
    const safeEnvironment = JSON.parse(JSON.stringify(buildLocalDemoEnvironment({
      NODE_ENV: "production",
      NEXT_PUBLIC_AUTH_MODE: "live",
      NEXT_PUBLIC_REQUIRE_LOGIN: "1",
      NEXT_PUBLIC_E2E_AUTH_BYPASS: "1",
    }))) as NodeJS.ProcessEnv;
    Object.assign(process.env, safeEnvironment);

    expect(isLiveAuth()).toBe(false);
    expect(isLocalRuntime()).toBe(true);
    expect(process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS).toBe("");

    const persisted = buildPersistedScanState({
      userId: null,
      businessId: "local-demo",
      sessionId: "session-1",
      currentSession: { id: "session-1" },
      location: "Bay 1",
      recentLocations: ["Bay 1"],
      settings: {},
      pendingSyncQueue: [],
      syncedScanEventIds: [],
      simulateSyncFailure: false,
      products: [{ id: "p1", barcodes: ["012345678905"] }],
      aliases: [{ code: "012345678905", productId: "p1" }],
      scanFeed: [{ id: "e1", cleanCode: "012345678905" }],
      finalCounts: [{ productId: "p1", quantity: 1 }],
      needsReviewQueue: [],
      lastCleanupBackup: null,
      catalog: [{ id: "p1" }],
      shopOverrides: [{ code: "012345678905" }],
      feedbackEvents: [],
      countSnapshots: [],
      firstScanAt: null,
      sessionHistory: [],
    });
    const reloaded = JSON.parse(JSON.stringify(persisted));
    expect(reloaded).toMatchObject({
      products: [{ id: "p1", barcodes: ["012345678905"] }],
      aliases: [{ code: "012345678905", productId: "p1" }],
      scanFeed: [{ id: "e1", cleanCode: "012345678905" }],
      catalog: [{ id: "p1" }],
      shopOverrides: [{ code: "012345678905" }],
    });
  });
});
