// Provider/source outcome shape shared by the server response and diagnostics.

/** Per-provider/per-source outcome - so failures are SURFACED, never hidden behind a generic message. */
export type ProviderStatusCode = "ok" | "no_match" | "skipped" | "rate_limited" | "timeout" | "error";

export interface ProviderStatus {
  provider: string;
  status: ProviderStatusCode;
  latencyMs: number;
  errorCode?: string; // safe code only (e.g. "429", "timeout", "500") - never a key or stack trace
  sourceUrlsReturned: number;
  exactCodeFound: boolean;
  identityFound: boolean;
}
