import { NextRequest, NextResponse } from "next/server";
import { isLocalDemo } from "@/server/localDemo";
import { localDemoUnavailableResponse } from "@/server/localDemoHttp";

const ALLOWED_LOCAL_DEMO_API =
  /^\/api\/(?:ai-lookup|local-demo\/status|local-demo\/manifest\/(?:0[1-9]|[12][0-9]|30))$/;

export function proxy(request: NextRequest): NextResponse {
  if (
    isLocalDemo() &&
    !ALLOWED_LOCAL_DEMO_API.test(request.nextUrl.pathname)
  ) {
    return localDemoUnavailableResponse();
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
