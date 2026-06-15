// Pure, dependency-free helpers for loading a Firebase Admin service account from a Vercel-style env var
// (no secret file on disk). Deliberately free of `firebase-admin` / `server-only` imports so it is
// unit-testable in the fast node test project. NEVER logs or includes secret contents in error messages.

export interface AdminServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

// Resolve the raw service-account JSON string from the supported env vars: FIREBASE_SERVICE_ACCOUNT_JSON
// (primary) or FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (fallback). Returns undefined when neither is set, so
// the caller can fall back to a local file path / application-default credentials.
export function serviceAccountJsonFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const direct = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (direct && direct.trim()) return direct;
  const b64 = env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (b64 && b64.trim()) return Buffer.from(b64, "base64").toString("utf8");
  return undefined;
}

// Parse a service-account JSON string into the firebase-admin credential shape. Accepts the standard Google
// snake_case keys (and camelCase as a courtesy) and normalizes the common "\n"-escaped private_key so PEM
// parsing works when the secret was stored on a single line. Throws a REDACTED error (never the secret
// value) on invalid or incomplete input.
export function parseServiceAccountJson(raw: string): AdminServiceAccount {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON");
  }

  const projectId: unknown = parsed.project_id ?? parsed.projectId;
  const clientEmail: unknown = parsed.client_email ?? parsed.clientEmail;
  let privateKey: unknown = parsed.private_key ?? parsed.privateKey;
  if (typeof privateKey === "string") privateKey = privateKey.replace(/\\n/g, "\n");

  const missing: string[] = [];
  if (typeof projectId !== "string" || !projectId) missing.push("project_id");
  if (typeof clientEmail !== "string" || !clientEmail) missing.push("client_email");
  if (typeof privateKey !== "string" || !privateKey) missing.push("private_key");
  if (missing.length) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is missing required field(s): ${missing.join(", ")}`);
  }

  return {
    projectId: projectId as string,
    clientEmail: clientEmail as string,
    privateKey: privateKey as string,
  };
}
