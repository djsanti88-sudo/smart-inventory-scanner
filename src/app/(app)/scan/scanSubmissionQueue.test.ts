import { describe, expect, it, vi } from "vitest";
import { createScanSubmissionQueue } from "./scanSubmissionQueue";

describe("scan submission queue", () => {
  it("runs exactly one queued single at each bulk boundary, then drains the rest FIFO", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const queue = createScanSubmissionQueue({
      processScan: (code) => { calls.push(code); },
      chunkSize: 2,
      yieldToBrowser: () => new Promise<void>((resolve) => releases.push(resolve)),
    });

    const bulk = queue.enqueueBulk(["b1", "b2", "b3", "b4", "b5"]);
    await Promise.resolve();
    queue.enqueueSingle("s1");
    queue.enqueueSingle("s2");
    expect(calls).toEqual(["b1", "b2"]);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["b1", "b2", "s1", "b3", "b4"]);
    releases.shift()?.();
    await bulk;

    expect(calls).toEqual(["b1", "b2", "s1", "b3", "b4", "s2", "b5"]);
  });

  it("keeps later singles and later bulk work when stopping only the active bulk", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const queue = createScanSubmissionQueue({
      processScan: (code) => { calls.push(code); },
      chunkSize: 2,
      yieldToBrowser: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    const first = queue.enqueueBulk(["a1", "a2", "a3", "a4", "a5"]);
    await Promise.resolve();
    queue.enqueueSingle("single");
    const second = queue.enqueueBulk(["z1", "z2"]);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["a1", "a2", "single"]);
    queue.stopActiveBulk();

    await first;
    await second;
    expect(calls).toEqual(["a1", "a2", "single", "z1", "z2"]);
  });

  it("reports a callback failure, continues every accepted code, and never overlaps calls", async () => {
    const calls: string[] = [];
    const failures = vi.fn();
    let active = 0;
    let maximum = 0;
    const queue = createScanSubmissionQueue({
      processScan: async (code) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        calls.push(code);
        if (code === "bad") throw new Error("bad scan");
      },
      chunkSize: 20,
      onError: failures,
    });

    await Promise.all([queue.enqueueBulk(["one", "bad", "two"]), queue.enqueueSingle("later")]);
    expect(calls).toEqual(["one", "bad", "two", "later"]);
    expect(maximum).toBe(1);
    expect(failures).toHaveBeenCalledWith(expect.objectContaining({ code: "bad" }));
  });

  it("does not process an already-aborted bulk job", async () => {
    const processScan = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const queue = createScanSubmissionQueue({ processScan });
    await queue.enqueueBulk(["never"], controller);
    expect(processScan).not.toHaveBeenCalled();
  });
});
