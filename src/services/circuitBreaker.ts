import type { AiCircuitState } from "@/types";

// Cost + reliability guard for AI lookups. Two independent protections:
//  1. A consecutive-failure circuit breaker (closed -> open -> half_open -> closed).
//  2. A daily request cap.
// Pure functions; time is injected (no Date.now) so the state machine is fully testable.

export interface BreakerState {
  state: AiCircuitState;
  failures: number;
  openedAt: number | null;
}

export const FAILURE_THRESHOLD = 3;
export const COOLDOWN_MS = 30_000;

export function initBreaker(): BreakerState {
  return { state: "closed", failures: 0, openedAt: null };
}

export function recordSuccess(): BreakerState {
  return { state: "closed", failures: 0, openedAt: null };
}

export function recordFailure(prev: BreakerState, now: number): BreakerState {
  const failures = prev.failures + 1;
  if (failures >= FAILURE_THRESHOLD) {
    return { state: "open", failures, openedAt: now };
  }
  return { ...prev, state: prev.state === "half_open" ? "open" : prev.state, failures, openedAt: prev.state === "half_open" ? now : prev.openedAt };
}

/**
 * Decide whether a request may proceed. When the breaker is open and the cooldown has elapsed,
 * it transitions to half_open and allows a single trial request.
 */
export function canRequest(prev: BreakerState, now: number): { allowed: boolean; next: BreakerState } {
  if (prev.state === "closed" || prev.state === "half_open") {
    return { allowed: true, next: prev };
  }
  // open
  if (prev.openedAt != null && now - prev.openedAt >= COOLDOWN_MS) {
    return { allowed: true, next: { ...prev, state: "half_open" } };
  }
  return { allowed: false, next: prev };
}

export function isDailyCapReached(count: number, limit: number): boolean {
  return limit > 0 && count >= limit;
}

export type AiGateReason = "ok" | "disabled" | "offline" | "daily_cap" | "circuit_open";

/** Combined gate used by the store before any AI call. */
export function evaluateAiGate(params: {
  enabled: boolean;
  online: boolean;
  dailyCount: number;
  dailyLimit: number;
  breaker: BreakerState;
  now: number;
}): { allowed: boolean; reason: AiGateReason; breaker: BreakerState } {
  if (!params.enabled) return { allowed: false, reason: "disabled", breaker: params.breaker };
  if (!params.online) return { allowed: false, reason: "offline", breaker: params.breaker };
  if (isDailyCapReached(params.dailyCount, params.dailyLimit))
    return { allowed: false, reason: "daily_cap", breaker: params.breaker };
  const gate = canRequest(params.breaker, params.now);
  if (!gate.allowed) return { allowed: false, reason: "circuit_open", breaker: gate.next };
  return { allowed: true, reason: "ok", breaker: gate.next };
}
