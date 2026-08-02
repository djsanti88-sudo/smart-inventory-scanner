import { afterEach, describe, expect, it, vi } from "vitest";
import { persistKeyForUid } from "./scanPersistNamespace";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("persistKeyForUid", () => {
  it("keeps the legacy global key for anon/mock (null uid)", () => {
    expect(persistKeyForUid(null)).toBe("sis-scan-v1");
  });
  it("namespaces by uid for a signed-in user", () => {
    expect(persistKeyForUid("abc123")).toBe("sis-scan-abc123");
  });

  it("uses a dedicated local-demo key for every identity", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");

    expect(persistKeyForUid(null)).toBe("sis-local-demo-scan-v1");
    expect(persistKeyForUid("abc123")).toBe("sis-local-demo-scan-v1");
  });
});
