// src/app/api/version/route.test.ts
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/version/route";

// This route is the observable deploy proof: after the Vercel git cutover, hitting
// /api/version on the live site must show which commit Vercel actually built. Vercel injects
// VERCEL_GIT_COMMIT_SHA only on git-connected deploys, so the "unknown" fallback path is not
// dead code - it is the signal that a build did NOT come through the git pipeline.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/version", () => {
  it("returns the Vercel git commit sha when present", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sha).toBe("abc1234");
    expect(typeof body.deployedAt).toBe("string");
  });

  it("falls back to NEXT_PUBLIC_GIT_SHA when VERCEL_GIT_COMMIT_SHA is absent", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("NEXT_PUBLIC_GIT_SHA", "def5678");
    const res = await GET();
    const body = await res.json();
    expect(body.sha).toBe("def5678");
  });

  it("falls back to \"unknown\" when neither sha env var is set (a non-git-pipeline deploy)", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("NEXT_PUBLIC_GIT_SHA", "");
    const res = await GET();
    const body = await res.json();
    expect(body.sha).toBe("unknown");
  });

  it("sets no-store cache headers so the proof is never stale", async () => {
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns deployedAt as a valid ISO timestamp", async () => {
    const res = await GET();
    const body = await res.json();
    expect(new Date(body.deployedAt).toISOString()).toBe(body.deployedAt);
  });
});
