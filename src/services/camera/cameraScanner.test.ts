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

  it("falls back to the dynamic-imported polyfill when window.BarcodeDetector is absent, and a detected barcode reaches onDetect through that path", async () => {
    // window.BarcodeDetector deliberately left undefined so loadDetector() falls through to the
    // dynamic import path. Mock the "barcode-detector" module itself (rather than the real
    // zxing-wasm polyfill) with a controllable detect() queue, so we can prove a detection
    // actually reaches onDetect through the polyfill code path - not just that start()/stop()
    // resolve without throwing.
    expect((window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector).toBeUndefined();

    class MockPolyfillDetector {
      static lastInstance: MockPolyfillDetector | null = null;
      detectQueue: Array<Array<{ rawValue: string }>> = [];
      constructor() {
        MockPolyfillDetector.lastInstance = this;
      }
      async detect(_video: unknown) {
        return this.detectQueue.shift() ?? [];
      }
    }

    vi.doMock("barcode-detector", () => ({
      BarcodeDetector: MockPolyfillDetector,
    }));
    vi.resetModules();
    const { createCameraScanner: createCameraScannerFresh } = await import("@/services/camera/cameraScanner");

    const video = makeVideo();
    const onDetect = vi.fn();
    const scanner = createCameraScannerFresh(video, onDetect);
    await expect(scanner.start()).resolves.not.toThrow();

    expect(MockPolyfillDetector.lastInstance).not.toBeNull();

    MockPolyfillDetector.lastInstance!.detectQueue.push([{ rawValue: "POLYFILL-CODE-123" }]);
    await tick();

    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(onDetect).toHaveBeenCalledWith("POLYFILL-CODE-123");

    scanner.stop();
    vi.doUnmock("barcode-detector");
    vi.resetModules();
  });

  it("rejects cleanly with a normal Error when the detector fails to load, and a subsequent stop() is safe with no rAF scheduled", async () => {
    // window.BarcodeDetector deliberately left undefined so loadDetector() falls through to the
    // dynamic import path. Mock the dynamic import to reject, simulating offline / chunk 404.
    vi.doMock("barcode-detector", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    vi.resetModules();
    const { createCameraScanner: createCameraScannerFresh } = await import("@/services/camera/cameraScanner");

    const video = makeVideo();
    const onDetect = vi.fn();
    const scanner = createCameraScannerFresh(video, onDetect);

    let caught: unknown;
    try {
      await scanner.start();
    } catch (err) {
      caught = err;
    }

    // Must reject with a real Error the caller can catch (not swallowed, not a raw string/undefined).
    expect(caught).toBeInstanceOf(Error);

    // No detection loop should have been scheduled since the detector never loaded.
    expect(rafCallbacks.length).toBe(0);

    // A subsequent stop() call must be safe: no throw, no double-release, and it must not schedule
    // or cancel a phantom rAF handle.
    expect(() => scanner.stop()).not.toThrow();
    expect(rafCallbacks.length).toBe(0);

    vi.doUnmock("barcode-detector");
    vi.resetModules();
  });
});
