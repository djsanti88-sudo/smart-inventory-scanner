// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimit, decodeStorage, logServerEvent } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  decodeStorage: vi.fn(),
  logServerEvent: vi.fn(),
}));

vi.mock("@/decoding/limits/aiSpendGuard", () => ({
  checkRateLimit,
  intEnv: (_raw: string | undefined, fallback: number) => fallback,
}));
vi.mock("@/server/decode/storage", () => ({ decodeStorage }));
vi.mock("@/server/log", () => ({ logServerEvent }));

import { POST } from "./route";

const telemetry = (body: unknown, headers: HeadersInit = {}) => new Request("http://localhost/api/telemetry", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("POST /api/telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0, remaining: 99 });
  });

  it("logs an allowlisted breaker event with server-derived fields only", async () => {
    const response = await POST(telemetry({
      event: "breaker_open",
      detail: "x".repeat(250),
      route: "/api/account/export",
      businessId: "victim",
      status: 500,
      reasonCode: "forged",
    }));

    expect(response.status).toBe(204);
    expect(logServerEvent).toHaveBeenCalledWith({
      route: "/api/telemetry",
      event: "breaker_open",
      reasonCode: "client_circuit_breaker_open",
      status: 202,
      detail: "x".repeat(200),
    });
  });

  it("rejects non-allowlisted events without logging them", async () => {
    const response = await POST(telemetry({ event: "admin_login_ok" }));
    expect(response.status).toBe(400);
    expect(logServerEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON and actual UTF-8 bodies that exceed the cap before parsing", async () => {
    expect((await POST(telemetry("{"))).status).toBe(400);
    expect((await POST(telemetry("😀".repeat(300)))).status).toBe(413);
    expect(logServerEvent).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const response = await POST(telemetry({ event: "client_error" }, { "content-length": "999999" }));
    expect(response.status).toBe(413);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("uses one bounded anonymous limiter key when forwarded headers rotate", async () => {
    expect((await POST(telemetry(
      { event: "client_error" },
      { "x-forwarded-for": "198.51.100.1" },
    ))).status).toBe(204);
    expect((await POST(telemetry(
      { event: "client_error" },
      { "x-forwarded-for": "198.51.100.2", "x-real-ip": "198.51.100.3" },
    ))).status).toBe(204);

    expect(checkRateLimit).toHaveBeenCalledTimes(2);
    expect(checkRateLimit.mock.calls[0][0]).toBe("TELEMETRY:anonymous:client_error");
    expect(checkRateLimit.mock.calls[1][0]).toBe("TELEMETRY:anonymous:client_error");
    expect(checkRateLimit.mock.calls[0][1]).not.toHaveProperty("storage");
    expect(decodeStorage).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter rejects the request", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 2500, remaining: 0 });
    const response = await POST(telemetry({ event: "client_error" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(logServerEvent).not.toHaveBeenCalled();
  });
});
