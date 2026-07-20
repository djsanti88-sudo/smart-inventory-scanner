import { NextRequest, NextResponse } from "next/server";
import {
  normalizeBossReportSnapshot,
  resolveShareToken,
} from "@/server/share/shareTokenStore";

export const runtime = "nodejs";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

// Deliberately unauthenticated. The random, expiring token resolves only to the immutable safe
// snapshot captured at mint time. This route never queries a tenant database.
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const payload = await resolveShareToken(token);
  if (!payload) {
    return json({ error: "This link has expired or does not exist." }, 404);
  }

  return json({
    report: normalizeBossReportSnapshot(payload.reportSnapshot),
    sessionId: payload.sessionId,
  });
}
