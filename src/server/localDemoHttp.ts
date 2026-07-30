import "server-only";

import { NextRequest, NextResponse } from "next/server";

const UNAVAILABLE_BODY = {
  error: "Unavailable in local tire demo",
  localDemo: true,
} as const;

const EVIDENCE_ERROR_BODY = {
  error: "Local demo evidence unavailable",
  localDemo: true,
} as const;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function localDemoUnavailableResponse(): NextResponse {
  return NextResponse.json(UNAVAILABLE_BODY, {
    status: 409,
    headers: NO_STORE_HEADERS,
  });
}

export function localDemoEvidenceErrorResponse(): NextResponse {
  return NextResponse.json(EVIDENCE_ERROR_BODY, {
    status: 500,
    headers: NO_STORE_HEADERS,
  });
}

export function localDemoNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, {
    status: 404,
    headers: NO_STORE_HEADERS,
  });
}

export function localDemoNoContentResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: NO_STORE_HEADERS,
  });
}

export function localDemoNullResponse(): NextResponse {
  return NextResponse.json(null, { headers: NO_STORE_HEADERS });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return Boolean(match?.slice(1).every((octet) => Number(octet) <= 255));
}

export function isLoopbackRequest(request: NextRequest): boolean {
  if (!isLoopbackHostname(request.nextUrl.hostname)) return false;
  const hostHeader = request.headers.get("host");
  if (!hostHeader) return true;
  try {
    return isLoopbackHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export const localDemoNoStoreHeaders = NO_STORE_HEADERS;
