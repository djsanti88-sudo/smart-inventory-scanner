import { describe, expect, it, vi } from "vitest";
import { createIdentityApplyRoute } from "@/server/identity/applyRoute";

describe("POST /api/identity/apply", () => {
  it("rejects caller-supplied authority and allows only server-authenticated owners or admins", async () => {
    const apply = vi.fn().mockResolvedValue({ importId: "import-1" });
    const handler = createIdentityApplyRoute({ enabled: () => true, authorize: async () => ({ actorId: "counter", businessId: "shop-a", role: "counter" }), apply });
    const response = await handler(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["token"], mode: "physical_count", actorId: "owner", role: "owner" }) }));
    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("returns 401 for missing authentication and 503 for auth/config failures", async () => {
    const unauthenticated = createIdentityApplyRoute({ enabled: () => true, authorize: async () => undefined, apply: vi.fn() });
    expect((await unauthenticated(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["token"], mode: "reconcile" }) }))).status).toBe(401);
    const unavailable = createIdentityApplyRoute({ enabled: () => true, authorize: async () => { throw new Error("config"); }, apply: vi.fn() });
    expect((await unavailable(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["token"], mode: "reconcile" }) }))).status).toBe(503);
  });

  it("maps in-progress and stale apply outcomes to conflict responses", async () => {
    const actor = { actorId: "owner", businessId: "shop-a", role: "owner" as const };
    const request = () => new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["token"], mode: "reconcile" }) });
    const inProgress = createIdentityApplyRoute({ enabled: () => true, authorize: async () => actor, apply: async () => { throw new Error("apply_in_progress"); } });
    expect((await inProgress(request())).status).toBe(409);
    const stale = createIdentityApplyRoute({ enabled: () => true, authorize: async () => actor, apply: async () => { throw new Error("apply_target_stale"); } });
    expect((await stale(request())).status).toBe(409);
    const versions = createIdentityApplyRoute({ enabled: () => true, authorize: async () => actor, apply: async () => { throw new Error("preview_versions_stale"); } });
    expect((await versions(request())).status).toBe(409);
    const unavailable = createIdentityApplyRoute({ enabled: () => true, authorize: async () => actor, apply: async () => { throw new Error("apply_source_unavailable"); } });
    expect((await unavailable(request())).status).toBe(503);
  });

  it("never exposes unknown internal apply errors", async () => {
    const handler = createIdentityApplyRoute({ enabled: () => true, authorize: async () => ({ actorId: "owner", businessId: "shop-a", role: "owner" }), apply: async () => { throw new Error("database password leaked"); } });
    const response = await handler(new Request("http://localhost/api/identity/apply", { method: "POST", body: JSON.stringify({ signedPayloads: ["token"], mode: "reconcile" }) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Identity apply was rejected.", code: "apply_internal_error" });
  });
});
