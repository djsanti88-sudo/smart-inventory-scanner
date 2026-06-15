import { describe, it, expect } from "vitest";
import {
  initBreaker,
  recordFailure,
  recordSuccess,
  canRequest,
  evaluateAiGate,
  isDailyCapReached,
  FAILURE_THRESHOLD,
  COOLDOWN_MS,
} from "@/services/circuitBreaker";

describe("circuit breaker state machine", () => {
  it("opens after the failure threshold", () => {
    let s = initBreaker();
    expect(s.state).toBe("closed");
    for (let i = 0; i < FAILURE_THRESHOLD; i++) s = recordFailure(s, 1000);
    expect(s.state).toBe("open");
  });

  it("blocks requests while open within the cooldown", () => {
    let s = initBreaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) s = recordFailure(s, 1000);
    const gate = canRequest(s, 1000 + COOLDOWN_MS - 1);
    expect(gate.allowed).toBe(false);
  });

  it("half-opens after the cooldown and allows a trial request", () => {
    let s = initBreaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) s = recordFailure(s, 1000);
    const gate = canRequest(s, 1000 + COOLDOWN_MS);
    expect(gate.allowed).toBe(true);
    expect(gate.next.state).toBe("half_open");
  });

  it("closes again on success", () => {
    const s = recordSuccess();
    expect(s.state).toBe("closed");
    expect(s.failures).toBe(0);
  });
});

describe("daily cap", () => {
  it("reports when the cap is reached", () => {
    expect(isDailyCapReached(25, 25)).toBe(true);
    expect(isDailyCapReached(24, 25)).toBe(false);
    expect(isDailyCapReached(0, 0)).toBe(false); // 0 limit = no cap configured
  });
});

describe("evaluateAiGate", () => {
  const base = {
    enabled: true,
    online: true,
    dailyCount: 0,
    dailyLimit: 25,
    breaker: initBreaker(),
    now: 0,
  };

  it("blocks when AI is disabled", () => {
    expect(evaluateAiGate({ ...base, enabled: false }).reason).toBe("disabled");
  });
  it("blocks when offline", () => {
    expect(evaluateAiGate({ ...base, online: false }).reason).toBe("offline");
  });
  it("blocks when the daily cap is reached (routes to Needs Review)", () => {
    expect(evaluateAiGate({ ...base, dailyCount: 25 }).reason).toBe("daily_cap");
  });
  it("allows a normal call", () => {
    expect(evaluateAiGate(base).allowed).toBe(true);
  });
});
