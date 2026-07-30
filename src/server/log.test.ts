// src/server/log.test.ts
// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { logServerEvent } from "@/server/log";

vi.mock("server-only", () => ({}));

describe("logServerEvent", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("emits a single-line JSON object shaped with src/route/event/ts", () => {
    logServerEvent({ route: "/api/ai-lookup", event: "kill_switch" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line);
    expect(parsed.src).toBe("scanbin");
    expect(parsed.route).toBe("/api/ai-lookup");
    expect(parsed.event).toBe("kill_switch");
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).toString()).not.toBe("Invalid Date");
  });

  it("routes status >= 500 to console.error", () => {
    logServerEvent({ route: "/api/resolve-scan", event: "read_failed", status: 500 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("routes status < 500 (and no status) to console.warn", () => {
    logServerEvent({ route: "/api/ai-lookup", event: "rate_limited", status: 429 });
    logServerEvent({ route: "/api/ai-lookup", event: "no_status_event" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("truncates detail defensively at 200 chars", () => {
    const long = "x".repeat(500);
    logServerEvent({ route: "/api/share", event: "mint_failed", detail: long });
    const line = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.detail.length).toBe(200);
    expect(parsed.detail).toBe("x".repeat(200));
  });

  it("emits only the six allowed keys plus ts and src; unknown keys are dropped", () => {
    // Deliberately widened to `Record<string, unknown>` then cast: proves the RUNTIME behavior
    // (unknown keys never leak into the emitted line) even though the LogEvent type would normally
    // reject these extra properties at the call site.
    const maliciousInput = {
      route: "/api/ai-lookup",
      event: "cap_blocked",
      reasonCode: "daily_cap",
      businessId: "biz-123",
      status: 429,
      detail: "daily cap reached",
      scannedCode: "012345678905",
      email: "owner@example.com",
    } as unknown as Parameters<typeof logServerEvent>[0];
    logServerEvent(maliciousInput);
    const line = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual(["businessId", "detail", "event", "reasonCode", "route", "src", "status", "ts"].sort());
    expect(parsed.scannedCode).toBeUndefined();
    expect(parsed.email).toBeUndefined();
  });

  it("honors an explicit severity:'error' override even when status is below 500 (silent-failure fix)", () => {
    // A 200-status health-degraded event must still page/alert as an error, not a routine warn.
    logServerEvent({ route: "/api/health", event: "degraded", status: 200, severity: "error" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("honors an explicit severity:'warn' override even when status is 500+ (symmetry, no surprises)", () => {
    logServerEvent({ route: "/api/resolve-scan", event: "handled_failure", status: 500, severity: "warn" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("omits optional keys entirely when not provided", () => {
    logServerEvent({ route: "/api/import-mapping", event: "auth_reject" });
    const line = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect("reasonCode" in parsed).toBe(false);
    expect("businessId" in parsed).toBe(false);
    expect("status" in parsed).toBe(false);
    expect("detail" in parsed).toBe(false);
  });
});
