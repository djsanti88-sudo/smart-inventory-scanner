// The single place the Turso/libsql driver is named.
//
// Five server modules independently reopened the same connection: retailKnowledgeIndex.ts,
// decodeCacheStore.ts, learnedProducts.ts, upc/storage.ts and share/shareTokenStore.ts each
// declared their own `TursoClient` type, their own `LibsqlClientModule` cast, and their own
// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN read. Changing the driver, the credential names, or the
// construction options therefore meant five identical edits, and they had already drifted (only
// shareTokenStore trimmed its env values).
//
// This module owns those three concerns and nothing else. It deliberately does NOT own the
// memoized client cell, the "unavailable" latch, or the log lines: each caller keeps its own
// cache lifecycle (its `__reset*ForTests()` hook depends on that) and its own log prefix, so
// behavior at every call site is unchanged. Swapping libsql for another driver is now one edit
// here plus whatever the callers' SQL needs.
//
// Server-only by placement under src/server. `server-only` is intentionally not imported here so
// this module does not retroactively impose that guard on the three callers that never had it.

/** Minimal shape of the `@libsql/client` client this codebase actually uses. */
export type TursoClient = {
  execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type TursoCredentials = { url: string; authToken: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibsqlClientModule = { createClient: (config: { url: string; authToken: string }) => any };

/**
 * Turso credentials from the environment, or null when either half is absent - the signal every
 * caller uses to latch itself "unavailable" and fall back to its file/SQLite path.
 */
export function tursoCredentialsFromEnv(): TursoCredentials | null {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) return null;
  return { url, authToken };
}

/**
 * Construct a client. `@libsql/client` is imported dynamically so a deployment without Turso
 * configured never loads the driver at all (it is also in next.config.ts's serverExternalPackages).
 * Throws whatever the driver throws; callers catch and degrade, they never propagate.
 */
export async function createTursoClient(creds: TursoCredentials): Promise<TursoClient> {
  const { createClient } = (await import("@libsql/client")) as unknown as LibsqlClientModule;
  return createClient({ url: creds.url, authToken: creds.authToken }) as TursoClient;
}
