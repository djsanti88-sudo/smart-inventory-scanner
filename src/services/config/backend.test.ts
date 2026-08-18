import { describe, it, expect, afterEach } from "vitest";
import { isCloudBackendEnabled } from "@/services/config/backend";

// This helper replaced a literal `process.env.NEXT_PUBLIC_FIREBASE_BACKEND === "1"` comparison in six
// files. Two properties of that literal are load-bearing and are pinned here, because a future
// "optimization" to either one would break callers silently:
//
//   1. STRICT "1". Any other truthy-looking value (true/yes/0/empty) means the local mock backend. The
//      scan store picks its SyncTarget from this, so a loosened check would point a mock-mode session
//      at a real cloud write path.
//   2. CALL-TIME reads. Several suites (history.test.tsx, scanPersist.test.ts, ProdFirebaseBanner.test.tsx)
//      set and delete this variable between cases and expect the next call to observe the change.
//      Caching it in a module-level const would make those suites pass or fail by import order.

const KEY = "NEXT_PUBLIC_FIREBASE_BACKEND";

afterEach(() => {
  delete process.env[KEY];
});

describe("isCloudBackendEnabled", () => {
  it("is false when the variable is absent (the default: local mock backend)", () => {
    delete process.env[KEY];
    expect(isCloudBackendEnabled()).toBe(false);
  });

  it("is true only for exactly \"1\"", () => {
    process.env[KEY] = "1";
    expect(isCloudBackendEnabled()).toBe(true);
  });

  it.each(["0", "", "true", "TRUE", "yes", "firebase", " 1"])(
    "is false for %j - no truthiness coercion, no trimming",
    (value) => {
      process.env[KEY] = value;
      expect(isCloudBackendEnabled()).toBe(false);
    },
  );

  it("re-reads the environment on every call, never caching the first answer", () => {
    delete process.env[KEY];
    expect(isCloudBackendEnabled()).toBe(false);
    process.env[KEY] = "1";
    expect(isCloudBackendEnabled()).toBe(true);
    delete process.env[KEY];
    expect(isCloudBackendEnabled()).toBe(false);
  });
});
