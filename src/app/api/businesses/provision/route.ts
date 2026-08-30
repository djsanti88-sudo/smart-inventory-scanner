import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import {
  provisionBusiness,
  type ProvisionIdentity,
} from "@/users-businesses/provisioning/provisioning";
import type {
  ProvisionRequest,
  ProvisionResponse,
} from "@/authentication/service/provisioningTypes";

export const runtime = "nodejs";

const MAX_NAME_LENGTH = 100;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}

function validRequest(value: unknown): ProvisionRequest | null {
  if (typeof value !== "object" || value === null || !("mode" in value)) return null;
  if (value.mode === "ensure_default") {
    if (
      "preferredBusinessId" in value
      && value.preferredBusinessId !== undefined
      && (
        typeof value.preferredBusinessId !== "string"
        || !BUSINESS_ID_PATTERN.test(value.preferredBusinessId)
      )
    ) {
      return null;
    }
    return {
      mode: "ensure_default",
      ...(
        "preferredBusinessId" in value
        && typeof value.preferredBusinessId === "string"
          ? { preferredBusinessId: value.preferredBusinessId }
          : {}
      ),
    };
  }
  if (
    value.mode === "create_named"
    && "name" in value
    && typeof value.name === "string"
    && value.name.trim().length > 0
    && value.name.trim().length <= MAX_NAME_LENGTH
    && "requestId" in value
    && typeof value.requestId === "string"
    && REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    return {
      mode: "create_named",
      name: value.name.trim(),
      requestId: value.requestId,
    };
  }
  return null;
}

function json(body: ProvisionResponse, status: number): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json({ status: "failed", reason: "not_authenticated" }, 401);

  let decoded: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decoded = await getAdminAuth().verifyIdToken(token);
  } catch {
    return json({ status: "failed", reason: "not_authenticated" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ status: "failed", reason: "invalid_request" }, 400);
  }
  const input = validRequest(body);
  if (!input) return json({ status: "failed", reason: "invalid_request" }, 400);

  const identity: ProvisionIdentity = {
    uid: decoded.uid,
    email: decoded.email ?? "",
    name: typeof decoded.name === "string" ? decoded.name : "",
  };

  try {
    const result = await provisionBusiness(getAdminDb(), identity, input);
    return json(result, 200);
  } catch {
    return json({ status: "failed", reason: "workspace_unavailable" }, 503);
  }
}
