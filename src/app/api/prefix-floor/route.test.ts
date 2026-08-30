// src/app/api/prefix-floor/route.test.ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const rateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/decoding/limits/aiSpendGuard", () => ({
  checkRateLimit: (...args: unknown[]) => rateLimit(...args),
  intEnv: (value: string | undefined, fallback: number) => Number(value) || fallback,
}));
vi.mock("@/server/decode/storage", () => ({ decodeStorage: vi.fn().mockResolvedValue({}) }));
import { GET } from "@/app/api/prefix-floor/route";

// F5 bundle-surgery (wave 2, 2026-07-20): this endpoint is the enrichment door the client uses to get
// the DERIVED-tier (2.3MB corpus-derived) prefix->brand naming aid AFTER a scanned row already appears
// and counts (TOP-LEVEL LAW: enrichment never blocks/suppresses a row). It must never leak anything but
// a brand-confidence naming aid, and it must validate its input (never a passthrough to the full index
// with an attacker-controlled string).

function req(url: string): Request {
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
});

describe("/api/prefix-floor", () => {
  it("remains unauthenticated but returns 429 after its public lookup quota is exhausted", async () => {
    rateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });

    const res = await GET(req("http://localhost/api/prefix-floor?code=051596000004") as never);

    expect(res.status).toBe(429);
  });
  it("400s on a non-digit code", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor?code=abc") as never);
    expect(res.status).toBe(400);
  });

  it("400s on a too-short code (< 8 digits)", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor?code=1234567") as never);
    expect(res.status).toBe(400);
  });

  it("400s on a too-long code (> 14 digits)", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor?code=123456789012345") as never);
    expect(res.status).toBe(400);
  });

  it("400s on a missing code", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor") as never);
    expect(res.status).toBe(400);
  });

  it("returns floor:null for a valid code with no known prefix", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor?code=111000222333") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.floor).toBeNull();
  });

  it("resolves a DERIVED-tier prefix (the seam this route exists for) with a family annotation", async () => {
    // 5603344 -> "general" (Continental family) - a REAL derived-tier entry, not in the client-safe SEED.
    const res = await GET(req("http://localhost/api/prefix-floor?code=5603344000016") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.floor).not.toBeNull();
    expect(body.floor.brand).toBe("General");
    expect(body.floor.familyLabel).toBe("Continental family");
    expect(body.floor.name).toBe("General (Continental family) / product unconfirmed");
  });

  it("resolves a SEED-tier prefix too (full index includes seed)", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor?code=051596000004") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.floor.brand).toBe("United Solutions");
  });

  it("returns floor:null for a misread GTIN (bad check digit), never a fabricated brand", async () => {
    const res = await GET(req("http://localhost/api/prefix-floor?code=012345678900") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.floor).toBeNull();
  });
});
