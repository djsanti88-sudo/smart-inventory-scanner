// src/app/api/prefix-floor/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { prefixFloorNameFull } from "@/server/catalog/prefixIndexServer";
import { checkRateLimit, intEnv } from "@/decoding/limits/aiSpendGuard";
import { decodeStorage } from "@/server/decode/storage";

// F5 bundle-surgery (wave 2, 2026-07-20): the DERIVED-tier prefix->brand map (2.3MB, generated from
// our 4M-row retail/tire corpus) must never reach the client bundle (see
// @/server/catalog/prefixIndexServer.ts). This tiny GET endpoint lets scanStore's synchronous
// "<Brand> / product unconfirmed" naming aid (SEED/LEARNED, client-safe, instant) get enriched
// AFTER the row already appears + counts with derived-tier brands the client-safe lookup can't see.
// No secrets, no auth change (same open access model as the ai-lookup GET status endpoint) - this
// only returns a brand-confidence naming aid, never product identity or verified data.

export const runtime = "nodejs";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// A public barcode's digit-only form is 8-14 digits (EAN-8 through GTIN-14). Anything else is not a
// candidate company-prefix code at all - reject early rather than doing a pointless lookup.
const CODE_SHAPE = /^\d{8,14}$/;
const MAX_REQUEST_BYTES = 2 * 1024;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return json({ error: "Prefix lookup request must be 2KB or smaller." }, 413);
  }
  if (new TextEncoder().encode(request.url).byteLength > MAX_REQUEST_BYTES) {
    return json({ error: "Prefix lookup request must be 2KB or smaller." }, 413);
  }
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  try {
    const rate = await checkRateLimit(`PREFIX_FLOOR:${clientIp}`, {
      limit: intEnv(process.env.PREFIX_FLOOR_RATE_LIMIT, 60),
      windowMs: intEnv(process.env.PREFIX_FLOOR_RATE_WINDOW_MS, 60_000),
      storage: await decodeStorage(),
    });
    if (!rate.allowed) {
      return NextResponse.json({ error: "Too many prefix lookups. Slow down and try again.", retryAfterMs: rate.retryAfterMs }, {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      });
    }
  } catch {
    // Fail open like the shared limiter: a storage outage must not take down scan naming aids.
  }
  const searchParams = new URL(request.url).searchParams;
  const code = (searchParams.get("code") || "").trim();
  if (!CODE_SHAPE.test(code)) {
    return json({ error: "code must be 8-14 digits" }, 400);
  }
  const codeType = detectCodeType(code);
  const floor = prefixFloorNameFull(code, codeType);
  if (!floor) return json({ floor: null });
  return json({ floor: { name: floor.name, brand: floor.brand, familyLabel: floor.familyLabel ?? null } });
}
