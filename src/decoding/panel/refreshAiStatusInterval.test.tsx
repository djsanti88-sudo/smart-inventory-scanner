import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import ScanPage from "@/app/(app)/scan/page";
import SettingsPage from "@/app/(app)/settings/page";
import { useScanStore } from "@/stores/scanStore";

// Silent-failure fix (review of 92e9c32c, fix 3b): a single per-mount refreshAiStatus() fetch can
// fail transiently. Without a periodic retry, a shop owner viewing Scan or Settings would see a
// stale AI/kill-switch status for the entire session. Both pages must poll refreshAiStatus() on a
// lightweight interval while mounted, and stop polling on unmount (no leaked timers/fetches).

const AI_LOOKUP_PATH = "/api/ai-lookup";

function countAiLookupCalls(fetchSpy: ReturnType<typeof vi.fn>): number {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).includes(AI_LOOKUP_PATH)).length;
}

beforeEach(() => {
  useScanStore.getState().clearLocalCache();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("periodic AI status refresh (silent-failure self-heal)", () => {
  it("Scan page re-calls refreshAiStatus on a 60s interval while mounted, and stops after unmount", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      const { unmount } = render(<ScanPage />);
      const afterMount = countAiLookupCalls(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(afterMount).toBeGreaterThan(0); // the existing mount-time refresh still fires

      await vi.advanceTimersByTimeAsync(60_000);
      const afterOneInterval = countAiLookupCalls(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(afterOneInterval).toBeGreaterThan(afterMount);

      unmount();
      await vi.advanceTimersByTimeAsync(120_000);
      const afterUnmount = countAiLookupCalls(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(afterUnmount).toBe(afterOneInterval); // no further calls once unmounted
    } finally {
      globalThis.fetch = original;
    }
  });

  it("Settings page re-calls refreshAiStatus on a 60s interval while mounted, and stops after unmount", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      const { unmount } = render(<SettingsPage />);
      const afterMount = countAiLookupCalls(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(afterMount).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(60_000);
      const afterOneInterval = countAiLookupCalls(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(afterOneInterval).toBeGreaterThan(afterMount);

      unmount();
      await vi.advanceTimersByTimeAsync(120_000);
      const afterUnmount = countAiLookupCalls(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(afterUnmount).toBe(afterOneInterval);
    } finally {
      globalThis.fetch = original;
    }
  });
});
