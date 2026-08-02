import { describe, expect, it, vi } from "vitest";
import { runScanBatch } from "./runScanBatch";

describe("runScanBatch", () => {
  it("yields between bounded chunks while processing 101 codes exactly once in order", async () => {
    const codes = Array.from({ length: 101 }, (_, index) => `code-${index + 1}`);
    const processed: string[] = [];
    const progress: Array<{ processed: number; total: number }> = [];
    const releases: Array<() => void> = [];
    const yieldToBrowser = vi.fn(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );

    const completion = runScanBatch(
      codes,
      (code) => {
        processed.push(code);
        return code;
      },
      {
        chunkSize: 20,
        yieldToBrowser,
        onProgress: (value) => progress.push(value),
      },
    );

    expect(processed).toEqual(codes.slice(0, 20));
    expect(progress).toEqual([{ processed: 20, total: 101 }]);
    expect(yieldToBrowser).toHaveBeenCalledTimes(1);

    while (releases.length > 0 || processed.length < codes.length) {
      const release = releases.shift();
      if (!release) throw new Error("batch did not request the next browser yield");
      release();
      await Promise.resolve();
      await Promise.resolve();
    }

    await expect(completion).resolves.toMatchObject({ last: "code-101", processed: 101, total: 101, failed: 0, cancelled: false });
    expect(processed).toEqual(codes);
    expect(new Set(processed).size).toBe(101);
    expect(progress.at(-1)).toEqual({ processed: 101, total: 101 });
    expect(yieldToBrowser).toHaveBeenCalledTimes(5);
  });

  it("returns null and reports completed progress for an empty batch", async () => {
    const processOne = vi.fn();
    const onProgress = vi.fn();

    await expect(runScanBatch([], processOne, { onProgress })).resolves.toMatchObject({ last: null, processed: 0, total: 0, failed: 0, cancelled: false });

    expect(processOne).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({ processed: 0, total: 0 });
  });

  it("reports a failed code and continues the remaining batch without an unhandled rejection", async () => {
    const processed: string[] = [];
    const onError = vi.fn();

    const result = await runScanBatch(
      ["good-1", "bad", "good-2"],
      (code) => {
        if (code === "bad") throw new Error("scan failed");
        processed.push(code);
        return code;
      },
      {
        chunkSize: 1,
        yieldToBrowser: async () => {},
        onError,
      },
    );

    expect(processed).toEqual(["good-1", "good-2"]);
    expect(result).toMatchObject({ last: "good-2", processed: 3, total: 3, failed: 1, cancelled: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "bad",
      index: 1,
      error: expect.any(Error),
    }));
  });

  it("stops future work after aborting at a chunk boundary without rolling back completed codes", async () => {
    const controller = new AbortController();
    const attempted: string[] = [];
    const completion = runScanBatch(
      Array.from({ length: 101 }, (_, index) => `code-${index + 1}`),
      (code) => {
        attempted.push(code);
        if (code === "code-5") throw new Error("not added");
      },
      {
        chunkSize: 20,
        signal: controller.signal,
        yieldToBrowser: async () => {
          if (attempted.length >= 40) controller.abort();
        },
      },
    );

    await expect(completion).resolves.toMatchObject({ processed: 40, total: 101, failed: 1, cancelled: true });
    expect(attempted).toHaveLength(40);
  });
});
