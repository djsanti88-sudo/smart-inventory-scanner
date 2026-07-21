// src/app/api/prefix-floor/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { detectCodeType } from "@/services/codeTypeDetector";
import { prefixFloorNameFull } from "@/server/catalog/prefixIndexServer";

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

export async function GET(request: NextRequest): Promise<NextResponse> {
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
