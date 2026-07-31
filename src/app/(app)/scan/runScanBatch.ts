export interface ScanBatchProgress {
  processed: number;
  total: number;
}

interface ScanBatchOptions {
  chunkSize?: number;
  yieldToBrowser?: () => Promise<void>;
  onProgress?: (progress: ScanBatchProgress) => void;
  onError?: (failure: { code: string; index: number; error: unknown }) => void;
}

const yieldToBrowserTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export async function runScanBatch<T>(
  codes: readonly string[],
  processOne: (code: string) => T,
  options: ScanBatchOptions = {},
): Promise<T | null> {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 20));
  const yieldToBrowser = options.yieldToBrowser ?? yieldToBrowserTask;
  const total = codes.length;
  let processed = 0;
  let last: T | null = null;

  if (total === 0) {
    options.onProgress?.({ processed, total });
    return last;
  }

  while (processed < total) {
    const chunkEnd = Math.min(processed + chunkSize, total);
    while (processed < chunkEnd) {
      const index = processed;
      const code = codes[index];
      try {
        last = processOne(code);
      } catch (error) {
        options.onError?.({ code, index, error });
      }
      processed += 1;
    }
    options.onProgress?.({ processed, total });
    if (processed < total) await yieldToBrowser();
  }

  return last;
}
