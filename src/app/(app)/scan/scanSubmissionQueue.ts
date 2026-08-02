import { runScanBatch, type ScanBatchProgress, type ScanBatchResult } from "./runScanBatch";

type ProcessScan<T> = (code: string) => T | Promise<T>;

export interface ScanSubmissionQueueOptions<T> {
  processScan: ProcessScan<T>;
  chunkSize?: number;
  yieldToBrowser?: () => Promise<void>;
  onBulkStart?: (progress: ScanBatchProgress) => void;
  onBulkProgress?: (progress: ScanBatchProgress) => void;
  onBulkComplete?: (result: ScanBatchResult<T>) => void;
  onError?: (failure: { code: string; index?: number; error: unknown }) => void;
}

type BulkJob<T> = {
  codes: readonly string[];
  controller: AbortController;
  resolve: (result: ScanBatchResult<T>) => void;
};

type SingleJob<T> = {
  code: string;
  resolve: (result: T | null) => void;
};

export interface ScanSubmissionQueue<T> {
  enqueueBulk(codes: readonly string[], controller?: AbortController): Promise<ScanBatchResult<T>>;
  enqueueSingle(code: string): Promise<T | null>;
  stopActiveBulk(): void;
  readonly activeBulk: boolean;
}

/** Page-owned FIFO serializer. It intentionally has no React lifecycle: accepted scans drain after navigation. */
export function createScanSubmissionQueue<T>(options: ScanSubmissionQueueOptions<T>): ScanSubmissionQueue<T> {
  const bulkJobs: BulkJob<T>[] = [];
  const singles: SingleJob<T>[] = [];
  let draining = false;
  let active: BulkJob<T> | null = null;

  const reportError = (code: string, error: unknown, index?: number) => options.onError?.({ code, index, error });

  async function processSingle(job: SingleJob<T>) {
    try {
      job.resolve(await options.processScan(job.code));
    } catch (error) {
      reportError(job.code, error);
      job.resolve(null);
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (bulkJobs.length > 0 || singles.length > 0) {
        if (bulkJobs.length === 0) {
          const single = singles.shift();
          if (single) await processSingle(single);
          continue;
        }

        active = bulkJobs.shift()!;
        options.onBulkStart?.({ processed: 0, total: active.codes.length });
        const result = await runScanBatch(active.codes, options.processScan, {
          chunkSize: options.chunkSize ?? 20,
          signal: active.controller.signal,
          yieldToBrowser: options.yieldToBrowser,
          onProgress: options.onBulkProgress,
          onError: ({ code, index, error }) => reportError(code, error, index),
          onChunkBoundary: async () => {
            const single = singles.shift();
            if (single) await processSingle(single);
          },
        });
        active.resolve(result);
        options.onBulkComplete?.(result);
        active = null;

        // No single can be stranded behind a newly queued paste.
        while (singles.length > 0) await processSingle(singles.shift()!);
      }
    } finally {
      draining = false;
      if (bulkJobs.length > 0 || singles.length > 0) void drain();
    }
  }

  return {
    enqueueBulk(codes, controller = new AbortController()) {
      return new Promise<ScanBatchResult<T>>((resolve) => {
        bulkJobs.push({ codes, controller, resolve });
        void drain();
      });
    },
    enqueueSingle(code) {
      return new Promise<T | null>((resolve) => {
        singles.push({ code, resolve });
        void drain();
      });
    },
    stopActiveBulk() {
      active?.controller.abort();
    },
    get activeBulk() {
      return active !== null;
    },
  };
}
