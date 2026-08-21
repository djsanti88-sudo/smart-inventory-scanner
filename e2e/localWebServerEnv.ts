import { join } from "node:path";

const EXTERNAL_LIBSQL_ENV = /(?:TURSO|LIBSQL).*(?:URL|TOKEN)|(?:URL|TOKEN).*(?:TURSO|LIBSQL)/i;
const REQUIRED_SCRUBBED_KEYS = [
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "LIBSQL_URL",
  "LIBSQL_AUTH_TOKEN",
] as const;

/** Build a child-server environment that cannot inherit a remote Turso/libsql connection. */
export function localE2EWebServerEnv(
  lane: string,
  overrides: Record<string, string>,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, overrides, {
    IS_E2E: "1",
    BOSS_CORPUS_LADDER_STORAGE_DIR: join(
      process.cwd(),
      ".playwright",
      "e2e-ladder-storage",
      lane,
    ),
  });

  for (const key of Object.keys(env)) {
    if (EXTERNAL_LIBSQL_ENV.test(key)) env[key] = "";
  }
  for (const key of REQUIRED_SCRUBBED_KEYS) env[key] = "";
  return env;
}
