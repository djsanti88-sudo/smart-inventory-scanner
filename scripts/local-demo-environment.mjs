import { buildDevEnvironment } from "./dev-environment.mjs";

export const LOCAL_DEMO_DENIED_ENV_KEYS = Object.freeze([
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GO_UPC_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "BRAVE_API_KEY",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_BASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_SERVICE_ACCOUNT_JSON_BASE64",
  "FIREBASE_SERVICE_ACCOUNT_PATH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NEXT_PUBLIC_CLOUD_CATALOG",
  "NEXT_PUBLIC_FIREBASE_ALLOW_PROD",
  ...Array.from({ length: 10 }, (_, index) => `FIRECRAWL_API_KEY_${index + 1}`),
]);

export function buildLocalDemoEnvironment(baseEnvironment = process.env) {
  const environment = buildDevEnvironment("mock", baseEnvironment);
  Object.assign(environment, {
    SCANBIN_LOCAL_DEMO: "1",
    NEXT_PUBLIC_LOCAL_DEMO: "1",
    NEXT_PUBLIC_AUTH_MODE: "mock",
    NEXT_PUBLIC_REQUIRE_LOGIN: "0",
    NEXT_PUBLIC_FIREBASE_BACKEND: "0",
    NEXT_PUBLIC_FIREBASE_USE_EMULATOR: "0",
    NEXT_PUBLIC_E2E_AUTH_BYPASS: "",
    ENABLE_LIVE_AI_LOOKUP: "false",
    ENABLE_AUTO_DECODE_ON_SCAN: "true",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  for (const key of LOCAL_DEMO_DENIED_ENV_KEYS) environment[key] = "";
  return environment;
}
