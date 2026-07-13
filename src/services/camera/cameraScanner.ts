// Pure camera-scan detection service. Wraps the Barcode Detection API (native `window.BarcodeDetector`
// when the browser has it, otherwise a dynamically-imported zxing-wasm polyfill from the
// `barcode-detector` package) in a small detection loop.
//
// NEVER transforms the raw detected value - it is passed to onDetect exactly as the detector
// returned it. Cleaning/normalizing happens downstream, same as the keyboard scan path.

export interface CameraScannerOptions {
  formats?: string[];
}

export interface CameraScanner {
  start(): Promise<void>;
  stop(): void;
}

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
}

// One physical barcode sitting in frame across many detection ticks must fire onDetect only once
// per this window; two DIFFERENT codes must each still emit.
const DEBOUNCE_MS = 1500;

export function createCameraScanner(video: HTMLVideoElement, onDetect: (raw: string) => void, opts?: CameraScannerOptions): CameraScanner {
  let detector: BarcodeDetectorLike | null = null;
  let rafHandle: number | null = null;
  let stopped = false;
  const lastEmittedAt = new Map<string, number>();

  async function loadDetector(): Promise<BarcodeDetectorLike> {
    const NativeCtor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (NativeCtor) {
      return new NativeCtor({ formats: opts?.formats });
    }
    const polyfill = await import("barcode-detector");
    const PolyfillCtor = polyfill.BarcodeDetector as unknown as BarcodeDetectorCtor;
    return new PolyfillCtor({ formats: opts?.formats });
  }

  async function tick() {
    if (stopped || !detector) return;
    try {
      const detections = await detector.detect(video);
      if (stopped) return;
      const now = Date.now();
      for (const d of detections) {
        const raw = d.rawValue;
        const last = lastEmittedAt.get(raw);
        if (last !== undefined && now - last < DEBOUNCE_MS) continue;
        lastEmittedAt.set(raw, now);
        onDetect(raw);
      }
    } catch {
      // A single failed detect() tick (e.g. video not ready yet) should not kill the loop.
    }
    if (stopped) return;
    rafHandle = requestAnimationFrame(() => {
      void tick();
    });
  }

  return {
    async start() {
      stopped = false;
      detector = await loadDetector();
      if (stopped) return;
      rafHandle = requestAnimationFrame(() => {
        void tick();
      });
    },
    stop() {
      stopped = true;
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    },
  };
}
