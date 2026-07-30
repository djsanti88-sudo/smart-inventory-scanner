import "server-only";

// Structured server-side event logger (P6 Task B2, GC-B). No third-party SDK (owner
// no-new-accounts rule): visibility is a single-line JSON console.error/console.warn, readable
// straight from Vercel's function logs.
//
// HARD SANITIZATION LAW (GC-B): never log request bodies, scanned codes, product identities,
// emails, tokens, or prices. The LogEvent type below is the WHOLE allowed surface - only its
// six named keys (+ ts + src) are ever emitted; any other property passed in is silently
// dropped, never forwarded. `detail` must be a short, static-ish string (a fixed label, not
// interpolated user input) and is defensively truncated to 200 chars regardless.
//
// KNOWN GAP (plan review F9): the circuit breaker's OPEN transition is client-only state
// (src/stores/scanStore.ts) with no server call site today - it stays server-invisible after
// this change. Closing that gap needs a new client telemetry POST endpoint, explicitly out of
// scope for B2.

const MAX_DETAIL_LENGTH = 200;

export interface LogEvent {
  route: string;
  event: string;
  reasonCode?: string;
  businessId?: string;
  status?: number;
  detail?: string;
  /** Explicit level override (silent-failure fix). Without this, level is derived from `status`
   *  (>=500 -> console.error, else console.warn) - but some events (e.g. a 200 health response
   *  that is honestly ok:false) must page as an error even though the HTTP status itself must
   *  stay a benign 200 for uptime monitors. Set this to force the level regardless of `status`. */
  severity?: "error" | "warn";
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Emits one structured JSON line for a server-side API event (error, block, 429, kill switch,
 * cap trip, etc). status >= 500 logs via console.error; everything else (4xx, or no status)
 * logs via console.warn. Only the LogEvent keys above are ever included in the output - no
 * request bodies, codes, identities, emails, tokens, or prices.
 */
export function logServerEvent(input: LogEvent): void {
  const line: Record<string, unknown> = {
    src: "scanbin",
    route: input.route,
    event: input.event,
    ts: new Date().toISOString(),
  };
  if (input.reasonCode !== undefined) line.reasonCode = input.reasonCode;
  if (input.businessId !== undefined) line.businessId = input.businessId;
  if (input.status !== undefined) line.status = input.status;
  if (input.detail !== undefined) line.detail = truncate(input.detail, MAX_DETAIL_LENGTH);

  const payload = JSON.stringify(line);
  const level = input.severity ?? (typeof input.status === "number" && input.status >= 500 ? "error" : "warn");
  if (level === "error") {
    console.error(payload);
  } else {
    console.warn(payload);
  }
}
