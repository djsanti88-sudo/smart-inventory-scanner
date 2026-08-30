import "server-only";

import { NextResponse } from "next/server";
import { checkRateLimit, intEnv } from "@/decoding/limits/aiSpendGuard";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";

const MAX_TELEMETRY_BODY_BYTES = 1_024;
const MAX_TELEMETRY_DETAIL_LENGTH = 200;
const TELEMETRY_RATE_LIMIT = 60;
const ALLOWED_EVENTS = new Set(["breaker_open", "client_error"]);

type TelemetryEvent = "breaker_open" | "client_error";
type TelemetryBody = { event?: unknown; detail?: unknown };

function json(body: unknown, statusOrInit: number | ResponseInit): NextResponse {
  const init = typeof statusOrInit === "number"
    ? { status: statusOrInit, headers: { "Cache-Control": "no-store" } }
    : { ...statusOrInit, headers: { ...statusOrInit.headers, "Cache-Control": "no-store" } };
  return NextResponse.json(body, init);
}

function sanitizeDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, MAX_TELEMETRY_DETAIL_LENGTH);
  return sanitized || undefined;
}

function serverFields(event: TelemetryEvent): { reasonCode: string; status: number } {
  return event === "breaker_open"
    ? { reasonCode: "client_circuit_breaker_open", status: 202 }
    : { reasonCode: "client_unhandled_error", status: 202 };
}

export async function POST(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEMETRY_BODY_BYTES) {
    return json({ error: "Telemetry payload is too large." }, 413);
  }

  let body: TelemetryBody;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_TELEMETRY_BODY_BYTES) {
      return json({ error: "Telemetry payload is too large." }, 413);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as TelemetryBody;
  } catch {
    return json({ error: "Invalid telemetry payload." }, 400);
  }

  if (typeof body.event !== "string" || !ALLOWED_EVENTS.has(body.event)) {
    return json({ error: "Unsupported telemetry event." }, 400);
  }
  const event = body.event as TelemetryEvent;

  try {
    // This endpoint has no authenticated identity. Never use forwarding headers as durable
    // limiter keys: clients can forge unlimited values and grow ladder_kv without bound. The
    // allowlisted event name gives diagnostics two fixed anonymous buckets while keeping a
    // storage-backed cap on the endpoint's resource use.
    const rate = await checkRateLimit(`TELEMETRY:anonymous:${event}`, {
      limit: intEnv(process.env.TELEMETRY_RATE_LIMIT, TELEMETRY_RATE_LIMIT),
    });
    if (!rate.allowed) {
      return json(
        { error: "Too many telemetry requests." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
      );
    }
  } catch {
    // Telemetry is diagnostic. A transient storage fault must never take down the app's error path.
  }

  const fields = serverFields(event);
  const detail = sanitizeDetail(body.detail);
  logServerEvent({
    route: "/api/telemetry",
    event,
    ...fields,
    ...(detail ? { detail } : {}),
  });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
