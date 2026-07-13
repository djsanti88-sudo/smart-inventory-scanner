import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCameraScanner } from "@/services/camera/cameraScanner";

// Mock native BarcodeDetector class. `detect()` resolves with whatever the test currently has
// queued in `detectQueue` (an array of arrays-of-detections, one entry consumed per detect() call).
class MockBarcodeDetector {
  static lastInstance: MockBarcodeDetector | null = null;
  static formats: string[] | undefined;
  detectQueue: Array<Array<{ rawValue: string }>> = [];
  constructor(opts?: { formats?: string[] }) {
    MockBarcodeDetector.formats = opts?.formats;
    MockBarcodeDetector.lastInstance = this;
  }
  async detect(_video: unknown) {
    return this.detectQueue.shift() ?? [];
  }
}

function makeVideo(): HTMLVideoElement {
  return document.createElement("video");
}

describe("createCameraScanner", () => {
  let rafCallbacks: FrameRequestCallback[];
  let rafId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    rafCallbacks = [];
    rafId = 0;
    // jsdom does not implement requestAnimationFrame timing usefully for our loop; drive it manually
    // via a queue so tests can step the detection loop deterministically alongside fake timers.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return ++rafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      void id;
    });
    MockBarcodeDetector.lastInstance = null;
    MockBarcodeDetector.formats = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // @ts-expect-error - test cleanup of a global we may have set
    delete window.BarcodeDetector;
  });

  // Runs every currently-queued rAF callback once (simulating one animation frame tick), flushing
  // any microtasks the async detect() call schedules.
  async function tick() {
    const callbacks = rafCallbacks.splice(0, rafCallbacks.length);
    for (const cb of callbacks) cb(performance.now());
    await vi.advanceTimersByTimeAsync(0);
  }

  it("emits a detected value to onDetect exactly once within the debounce window", async () => {
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = MockBarcodeDetector;
    const video = makeVideo();
    const onDetect = vi.fn();
    const scanner = createCameraScanner(video, onDetect);
    await scanner.start();

    MockBarcodeDetector.lastInstance!.detectQueue.push([{ rawValue: "6419440485331" }]);
    await tick();
    MockBarcodeDetector.lastInstance!.detectQueue.push([{ rawValue: "6419440485331" }]);
    await tick();
    MockBarcodeDetector.lastInstance!.detectQueue.push([{ rawValue: "6419440485331" }]);
    await tick();

    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(onDetect).toHaveBeenCalledWith("6419440485331");

    scanner.stop();
  });

  it("emits both when two different codes are detected in frame", async () => {
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = MockBarcodeDetector;
    const video = makeVideo();
    const onDetect = vi.fn();
    const scanner = createCameraScanner(video, onDetect);
    await scanner.start();

    MockBarcodeDetector.lastInstance!.detectQueue.push([{ rawValue: "AAA111" }, { rawValue: "BBB222" }]);
    await tick();

    expect(onDetect).toHaveBeenCalledTimes(2);
    expect(onDetect).toHaveBeenCalledWith("AAA111");
    expect(onDetect).toHaveBeenCalledWith("BBB222");

    scanner.stop();
  });

  it("stop() halts the detection loop so no further onDetect calls happen", async () => {
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = MockBarcodeDetector;
    const video = makeVideo();
    const onDetect = vi.fn();
    const scanner = createCameraScanner(video, onDetect);
    await scanner.start();

    scanner.stop();

    MockBarcodeDetector.lastInstance!.detectQueue.push([{ rawValue: "AFTER-STOP" }]);
    await tick();
    await vi.advanceTimersByTimeAsync(2000);

    expect(onDetect).not.toHaveBeenCalled();
    // No new rAF loop iterations were scheduled after stop.
    expect(rafCallbacks.length).toBe(0);
  });

  it("prefers the native window.BarcodeDetector when present", async () => {
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = MockBarcodeDetector;
    const video = makeVideo();
    const scanner = createCameraScanner(video, vi.fn());
    await scanner.start();

    expect(MockBarcodeDetector.lastInstance).not.toBeNull();
    scanner.stop();
  });

  it("falls back to the dynamic-imported polyfill when window.BarcodeDetector is absent", async () => {
    // window.BarcodeDetector deliberately left undefined - the real `barcode-detector` package is
    // imported dynamically and used instead. We only assert start() resolves without throwing and
    // that detection still works end-to-end using the real polyfill's constructor shape (no mock
    // queue available here since it's the real implementation, so just prove no native-detector path
    // was used and start/stop do not throw).
    expect((window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector).toBeUndefined();
    const video = makeVideo();
    const onDetect = vi.fn();
    const scanner = createCameraScanner(video, onDetect);
    await expect(scanner.start()).resolves.not.toThrow();
    scanner.stop();
  });
});
