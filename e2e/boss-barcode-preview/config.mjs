import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = (env, key) => {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Preview certification requires ${key}.`);
  }
  return value.trim();
};

export const PREVIEW_FIREBASE_PROJECT_ID = "smart-inventory-preview";

const SCRUBBED_KEYS = [
  "OPENAI_API_KEY", "GO_UPC_API_KEY", "GOUPC_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL",
  "BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN",
];

function previewError(message) {
  throw new Error(`Preview certification target rejected: ${message}`);
}

function assertNoInheritedPaidOrTursoCredentials(env) {
  for (const key of SCRUBBED_KEYS) {
    if (typeof env[key] === "string" && env[key].trim() !== "") previewError(`${key} must be scrubbed before the Preview Playwright config starts.`);
  }
}

function parsePreviewUrl(value) {
  let url;
  try { url = new URL(value); } catch { previewError("BOSS_PREVIEW_URL must be an absolute HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    previewError("BOSS_PREVIEW_URL must be an HTTPS deployment origin without path, credentials, query, or fragment.");
  }
  if (!url.hostname.endsWith(".vercel.app") || /(^|[-.])(prod|production|main)([-.]|$)/i.test(url.hostname) || /smart-inventory-scanner-app/i.test(url.hostname)) {
    previewError("BOSS_PREVIEW_URL must be a non-production *.vercel.app Preview host.");
  }
  return url;
}

export function readTrustedVercelProject(options = undefined) {
  const projectFile = resolve(options?.cwd ?? process.cwd(), ".vercel", "project.json");
  let linked;
  try { linked = JSON.parse((options?.readFileSync ?? readFileSync)(projectFile, "utf8")); }
  catch { previewError("the trusted local .vercel/project.json link is unavailable or invalid."); }
  if (!linked || typeof linked.projectId !== "string" || linked.projectId.trim() === "" || typeof linked.projectName !== "string" || linked.projectName.trim() === "") {
    previewError("the trusted local .vercel/project.json link must contain projectId and projectName.");
  }
  return { projectId: linked.projectId.trim(), projectName: linked.projectName.trim() };
}

function linkedProjectId(options) {
  if (typeof options?.linkedProjectId === "string") return options.linkedProjectId;
  return readTrustedVercelProject(options).projectId;
}

export function readPreviewCertificationConfig(env = process.env, options = undefined) {
  assertNoInheritedPaidOrTursoCredentials(env);
  const url = parsePreviewUrl(REQUIRED(env, "BOSS_PREVIEW_URL"));
  const wrapperUrl = parsePreviewUrl(REQUIRED(env, "BOSS_PREVIEW_DEPLOYMENT_URL"));
  if (url.origin !== wrapperUrl.origin) previewError("BOSS_PREVIEW_URL does not equal the wrapper-emitted deployment URL.");
  // This identity comes from the linked checkout, never a caller-supplied environment value.
  const expectedVercelProjectId = linkedProjectId(options);
  let deploymentMetadata;
  try { deploymentMetadata = JSON.parse(REQUIRED(env, "BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON")); }
  catch { previewError("BOSS_PREVIEW_DEPLOYMENT_METADATA_JSON is not valid JSON."); }
  if (!deploymentMetadata || deploymentMetadata.url !== url.origin || deploymentMetadata.projectId !== expectedVercelProjectId || deploymentMetadata.target !== "preview") {
    previewError("wrapper deployment metadata does not bind this URL to the expected Vercel Preview project.");
  }
  let inspectMetadata;
  try { inspectMetadata = JSON.parse(REQUIRED(env, "BOSS_PREVIEW_VERCEL_INSPECT_METADATA_JSON")); }
  catch { previewError("BOSS_PREVIEW_VERCEL_INSPECT_METADATA_JSON is not valid JSON."); }
  if (!inspectMetadata || inspectMetadata.url !== url.origin || inspectMetadata.projectId !== expectedVercelProjectId || inspectMetadata.target !== "preview" || inspectMetadata.readyState !== "READY") {
    previewError("independent Vercel inspect metadata does not verify this ready Preview deployment.");
  }
  const productionHost = REQUIRED(env, "BOSS_PREVIEW_PRODUCTION_HOST").toLowerCase();
  if (url.hostname.toLowerCase() === productionHost) previewError("BOSS_PREVIEW_URL equals the declared production host.");
  if (REQUIRED(env, "BOSS_PREVIEW_FIREBASE_PROJECT_ID") !== PREVIEW_FIREBASE_PROJECT_ID) {
    previewError(`BOSS_PREVIEW_FIREBASE_PROJECT_ID must be ${PREVIEW_FIREBASE_PROJECT_ID}.`);
  }
  const runId = REQUIRED(env, "BOSS_PREVIEW_RUN_ID");
  if (!/^boss-preview-[a-z0-9-]{16,64}$/.test(runId)) previewError("BOSS_PREVIEW_RUN_ID is not a nonce-scoped preview run id.");
  const serviceAccountJson = typeof env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON === "string"
    ? env.BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON.trim()
    : "";
  const adcEnabled = env.BOSS_PREVIEW_FIREBASE_USE_ADC === "1";
  if (typeof env.BOSS_PREVIEW_FIREBASE_USE_ADC === "string" && env.BOSS_PREVIEW_FIREBASE_USE_ADC.trim() !== "" && !adcEnabled) {
    previewError("BOSS_PREVIEW_FIREBASE_USE_ADC must be exactly 1 when ADC is requested.");
  }
  let firebaseCredentialMode;
  if (serviceAccountJson) {
    try {
      if (JSON.parse(serviceAccountJson)?.project_id !== PREVIEW_FIREBASE_PROJECT_ID) previewError("preview service-account project does not match smart-inventory-preview.");
    } catch (error) {
      if (error instanceof SyntaxError) previewError("BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
      throw error;
    }
    firebaseCredentialMode = "service-account";
  } else {
    if (!adcEnabled) previewError("BOSS_PREVIEW_FIREBASE_SERVICE_ACCOUNT_JSON is unavailable and ADC was not explicitly enabled.");
    REQUIRED(env, "GOOGLE_APPLICATION_CREDENTIALS");
    firebaseCredentialMode = "adc";
  }
  const bypassSecret = REQUIRED(env, "VERCEL_AUTOMATION_BYPASS_SECRET");
  const protectionHeaders = /** @type {Record<string, string>} */ (bypassSecret === "not-required-unprotected-preview"
    ? {}
    : {
        "x-vercel-protection-bypass": bypassSecret,
        "x-vercel-set-bypass-cookie": "true",
      });
  return {
    baseURL: url.origin,
    expectedVercelProjectId,
    firebaseProjectId: PREVIEW_FIREBASE_PROJECT_ID,
    firebaseCredentialMode,
    runId,
    protectionHeaders,
  };
}

export function buildPreviewChildEnv(env = process.env) {
  const child = { ...env };
  for (const key of SCRUBBED_KEYS) child[key] = "";
  // ADC is opt-in: never pass an inherited application-default credential path to workers unless
  // the certification caller explicitly requested the Preview-only ADC fallback.
  const adcEnabled = env.BOSS_PREVIEW_FIREBASE_USE_ADC === "1";
  child.BOSS_PREVIEW_FIREBASE_USE_ADC = adcEnabled ? "1" : "";
  child.GOOGLE_APPLICATION_CREDENTIALS = adcEnabled && typeof env.GOOGLE_APPLICATION_CREDENTIALS === "string"
    ? env.GOOGLE_APPLICATION_CREDENTIALS
    : "";
  return {
    ...child,
    ENABLE_LIVE_AI_LOOKUP: "0",
    MASTER_CATALOG_APPEND: "0",
    IS_E2E: "0",
    NEXT_PUBLIC_E2E_AUTH_BYPASS: "0",
  };
}

export const previewScrubbedKeys = Object.freeze([...SCRUBBED_KEYS]);
