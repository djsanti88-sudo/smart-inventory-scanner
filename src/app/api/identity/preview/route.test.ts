import { describe, expect, it, vi } from "vitest";
import { createIdentityPreviewRoute } from "./route";

describe("POST /api/identity/preview", () => {
  it("is unavailable unless the local mock feature flag is enabled", async () => {
    const handler = createIdentityPreviewRoute({ enabled: () => false, createPreview: vi.fn() });
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Identity preview is unavailable." });
  });

  it("accepts only a bounded JSON preview request and delegates through injected local dependencies", async () => {
    const createPreview = vi.fn().mockResolvedValue({ preview: { importId: "import-1" }, signedPayloads: ["signed"] });
    const handler = createIdentityPreviewRoute({ enabled: () => true, createPreview });
    const body = { rows: [], orderedMappings: [], sourceFileHashes: [], importerVersion: "v1", issuedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" };
    const response = await handler(new Request("http://localhost/api/identity/preview", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(createPreview).toHaveBeenCalledWith(body);
  });
});
