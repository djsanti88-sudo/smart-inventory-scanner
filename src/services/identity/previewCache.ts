export interface PreviewCacheStorage {
  get(previewId: string): Promise<string[] | undefined>;
  put(previewId: string, signedPayloads: string[]): Promise<void>;
  delete(previewId: string): Promise<void>;
}

/** Browser-safe cache for signed preview chunks only; it intentionally cannot claim or apply imports. */
export function createMemoryPreviewCache(): PreviewCacheStorage {
  const entries = new Map<string, string[]>();
  return {
    async get(previewId) {
      const signedPayloads = entries.get(previewId);
      return signedPayloads ? [...signedPayloads] : undefined;
    },
    async put(previewId, signedPayloads) {
      entries.set(previewId, [...signedPayloads]);
    },
    async delete(previewId) {
      entries.delete(previewId);
    },
  };
}
