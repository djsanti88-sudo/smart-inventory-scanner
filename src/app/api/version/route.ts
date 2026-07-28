// src/app/api/version/route.ts
import "server-only";

import { NextResponse } from "next/server";

// Observable deploy proof (2026-07-27): after the Vercel git cutover, this is the only way to see
// which commit is actually serving production from the outside. Vercel injects
// VERCEL_GIT_COMMIT_SHA automatically on git-connected deploys; a CLI-only deploy (e.g. a stray
// `vercel deploy` run outside the git pipeline) will NOT have it set, so this endpoint answers
// "unknown" for that case - that asymmetry is itself proof the git pipeline built what is live.
// No secrets, no auth: this is a public commit SHA, same trust level as any deployed build asset.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(): Promise<NextResponse> {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_GIT_SHA || "unknown";
  const deployedAt = new Date().toISOString();
  return json({ sha, deployedAt });
}
