import { describe, it, expect, vi } from "vitest";
import { fetchWithBackoff, parseRetryAfterMs } from "@/shared/net/fetchWithBackoff";

function jsonRes(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("parseRetryAfterMs", () => {
  it("parses a plain seconds value", () => {
    expect(parseRetryAfterMs("60")).toBe(60000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses an HTTP-date value", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThan(40_000);
    expect(ms as number).toBeLessThanOrEqual(46_000);
  });

  it("returns null for garbage", () => {
    expect(parseRetryAfterMs("not-a-date-or-number")).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
  });
});

describe("fetchWithBackoff", () => {
  it("(a) honors a Retry-After: 60 header IN FULL - waits the full 60s, not capped at 30s", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return jsonRes(429, { error: "rate limited" }, { "Retry-After": "60" });
      return jsonRes(200, { ok: true });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let waitedMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      waitedMs = ms;
    });

    const res = await fetchWithBackoff("/api/ai-lookup", { method: "POST" }, { maxAttempts: 2, sleep });

    expect(waitedMs).toBe(60_000); // NOT the old 30_000 cap
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies only the safety ceiling (not a 30s cap) to an oversized Retry-After", async () => {
    const fetchMock = vi.fn(async () => jsonRes(429, {}, { "Retry-After": "999999" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let waitedMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      waitedMs = ms;
    });

    await fetchWithBackoff("/api/ai-lookup", {}, { maxAttempts: 2, maxRetryAfterMs: 90_000, sleep });

    expect(waitedMs).toBe(90_000);
  });

  it("(b) falls back to jittered exponential backoff when Retry-After is absent, bounded by the cap", async () => {
    const fetchMock = vi.fn(async () => jsonRes(429, {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const waits: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      waits.push(ms);
    });
    // Deterministic "random" so the test asserts an exact formula, not a range.
    const random = () => 0.5;

    await fetchWithBackoff(
      "/api/ai-lookup",
      {},
      { maxAttempts: 3, baseDelayMs: 1000, maxBackoffDelayMs: 30_000, sleep, random },
    );

    // attempt 1 -> 429 -> exponential = min(1000 * 2^0, 30000) = 1000; jittered = 0.5 * 1000 = 500
    // attempt 2 -> 429 -> exponential = min(1000 * 2^1, 30000) = 2000; jittered = 0.5 * 2000 = 1000
    expect(waits).toEqual([500, 1000]);
  });

  it("full jitter means two bursty callers hit with the same 429 do not retry at the identical delay", async () => {
    const fetchMock = vi.fn(async () => jsonRes(429, {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delaysA: number[] = [];
    const delaysB: number[] = [];
    let seed = 0.1;
    const randomA = () => {
      seed += 0.01;
      return seed % 1;
    };
    let seedB = 0.9;
    const randomB = () => {
      seedB -= 0.01;
      return Math.abs(seedB % 1);
    };

    await fetchWithBackoff(
      "/api/ai-lookup",
      {},
      { maxAttempts: 2, sleep: async (ms) => { delaysA.push(ms); }, random: randomA },
    );
    await fetchWithBackoff(
      "/api/ai-lookup",
      {},
      { maxAttempts: 2, sleep: async (ms) => { delaysB.push(ms); }, random: randomB },
    );

    expect(delaysA[0]).not.toBe(delaysB[0]);
  });

  it("(c) bounds total attempts and returns the final (still-429) response instead of looping forever", async () => {
    const fetchMock = vi.fn(async () => jsonRes(429, { error: "still limited" }, { "Retry-After": "0" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    const res = await fetchWithBackoff("/api/ai-lookup", {}, { maxAttempts: 3, sleep });

    expect(fetchMock).toHaveBeenCalledTimes(3); // never an unbounded/infinite retry loop
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("still limited");
  });

  it("onRetryDecision can veto a retry outright (e.g. a daily-cap 429 that will never clear by waiting)", async () => {
    const fetchMock = vi.fn(async () => jsonRes(429, { reasonCode: "daily_cap" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    const res = await fetchWithBackoff(
      "/api/ai-lookup",
      {},
      {
        maxAttempts: 5,
        sleep,
        onRetryDecision: async (r) => {
          const body = await r.json();
          return { retry: body.reasonCode !== "daily_cap" };
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1); // vetoed before any wait/retry
    expect(sleep).not.toHaveBeenCalled();
    const body = await res.json(); // original response body still readable (clone was used for the decision)
    expect(body.reasonCode).toBe("daily_cap");
  });

  it("passes a non-429 response straight through on the first attempt (no wait, no extra fetch)", async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    const res = await fetchWithBackoff("/api/ai-lookup", {}, { sleep });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("an AbortSignal that fires during the backoff wait rejects instead of retrying (never blocks a caller past its own abort)", async () => {
    const fetchMock = vi.fn(async () => jsonRes(429, {}, { "Retry-After": "60" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();

    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });

    const promise = fetchWithBackoff(
      "/api/ai-lookup",
      { signal: controller.signal },
      { maxAttempts: 2, sleep },
    );
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never fired a second fetch after the abort
  });
});
