export interface ScanBatchProgress {
  processed: number;
  total: number;
}

export interface ScanBatchResult<T> {
  last: T | null;
  processed: number;
  total: number;
  cancelled: boolean;
}

export interface ScanBatchOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  yieldToBrowser?: () => Promise<void>;
  onProgress?: (progress: ScanBatchProgress) => void;
  onError?: (failure: { code: string; index: number; error: unknown }) => void;
  onChunkBoundary?: () => Promise<void> | void;
}

const yieldToBrowserTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export async function runScanBatch<T>(
  codes: readonly string[],
  processOne: (code: string) => T | Promise<T>,
  options: ScanBatchOptions = {},
): Promise<ScanBatchResult<T>> {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 20));
  const yieldToBrowser = options.yieldToBrowser ?? yieldToBrowserTask;
  const total = codes.length;
  let processed = 0;
  let last: T | null = null;

  if (total === 0 || options.signal?.aborted) {
    options.onProgress?.({ processed, total });
    return { last, processed, total, cancelled: Boolean(options.signal?.aborted) };
  }

  while (processed < total) {
    const chunkEnd = Math.min(processed + chunkSize, total);
    while (processed < chunkEnd) {
      if (options.signal?.aborted) return { last, processed, total, cancelled: true };
      const index = processed;
      const code = codes[index];
      try {
        const value = processOne(code);
        last = value && typeof (value as { then?: unknown }).then === "function"
          ? await value
          : value as T;
      } catch (error) {
        options.onError?.({ code, index, error });
      }
      processed += 1;
    }
    options.onProgress?.({ processed, total });
    if (processed < total) {
      await yieldToBrowser();
      if (options.signal?.aborted) return { last, processed, total, cancelled: true };
      await options.onChunkBoundary?.();
    }
  }

  return { last, processed, total, cancelled: false };
}
