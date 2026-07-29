export type ClientTelemetryEvent = "breaker_open" | "client_error";

const ALLOWED_EVENTS = new Set<ClientTelemetryEvent>(["breaker_open", "client_error"]);
const MAX_DETAIL_LENGTH = 200;

/** Best-effort browser telemetry. This deliberately swallows failures to avoid error-reporting loops. */
export async function postTelemetry(event: ClientTelemetryEvent, detail?: string): Promise<void> {
  if (!ALLOWED_EVENTS.has(event)) return;
  const body = {
    event,
    ...(typeof detail === "string" && detail ? { detail: detail.slice(0, MAX_DETAIL_LENGTH) } : {}),
  };
  try {
    await fetch("/api/telemetry", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The app must remain usable if telemetry is blocked, offline, or rejected.
  }
}
