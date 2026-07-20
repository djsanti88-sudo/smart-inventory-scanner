// src/app/api/import-mapping/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { isLiveAuth } from "@/services/auth/authMode";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import type { ColumnMapping } from "@/services/importSchema";
import {
  getImportMappingMemory,
  putImportMappingMemory,
} from "@/server/importMappingMemory";

export const runtime = "nodejs";
const MAX_MAPPING_BODY_BYTES = 32 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

// Live mode verifies the caller's ID token and businessMembers membership before any read/write.
// IS_E2E=1 or mock mode is the explicit, documented credential-free bypass used by demos and tests.
async function authorize(businessId: string, idToken: string): Promise<NextResponse | null> {
  if (process.env.IS_E2E === "1" || !isLiveAuth()) return null;
  if (!idToken) return json({ error: "Sign in required." }, 401);
  let uid: string;
  try {
    uid = (await getAdminAuth().verifyIdToken(idToken)).uid;
  } catch (error) {
    if (authConfigurationError(error)) return json({ error: "Server auth is not configured." }, 503);
    return json({ error: "Invalid or expired sign-in." }, 401);
  }
  try {
    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`)
      .get();
    return member.exists ? null : json({ error: "Not a member of this business." }, 403);
  } catch (error) {
    if (authConfigurationError(error)) return json({ error: "Server auth is not configured." }, 503);
    return json({ error: "Could not verify business membership." }, 503);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = new URL(request.url).searchParams;
  const businessId = text(searchParams.get("businessId"));
  const sourceSignature = text(searchParams.get("sourceSignature"));
  const idToken = text(searchParams.get("idToken"));
  if (!businessId || !sourceSignature) {
    return json({ error: "businessId and sourceSignature are required." }, 400);
  }
  const denied = await authorize(businessId, idToken);
  if (denied) return denied;
  const record = await getImportMappingMemory(businessId, sourceSignature);
  return json({ mapping: record?.mapping ?? null });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MAPPING_BODY_BYTES) {
    return json({ error: "Import mapping must be 32KB or smaller." }, 413);
  }
  const raw = await request.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_MAPPING_BODY_BYTES) {
    return json({ error: "Import mapping must be 32KB or smaller." }, 413);
  }
  let body: { businessId?: unknown; sourceSignature?: unknown; mapping?: unknown; idToken?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const businessId = text(body.businessId);
  const sourceSignature = text(body.sourceSignature);
  const idToken = text(body.idToken);
  if (!businessId || !sourceSignature || !body.mapping || typeof body.mapping !== "object") {
    return json({ error: "businessId, sourceSignature, and mapping are required." }, 400);
  }
  const denied = await authorize(businessId, idToken);
  if (denied) return denied;
  await putImportMappingMemory({
    businessId,
    sourceSignature,
    mapping: body.mapping as ColumnMapping,
    updatedAt: new Date().toISOString(),
  });
  return json({ ok: true });
}
