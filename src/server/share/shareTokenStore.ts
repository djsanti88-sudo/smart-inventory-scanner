import "server-only";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BossReportData } from "@/reports/variance/bossReport";
import { createTursoClient, tursoCredentialsFromEnv, type TursoClient } from "@/decoding/server/tursoClient";

// A share token always points to the immutable, Boss Report safe snapshot captured when it was
// minted. The resolver never needs tenant database access.
export interface SharePayload {
  businessId: string;
  sessionId: string;
  reportSnapshot: BossReportData;
  createdAt: number;
  expiresAt: number;
}

type StoredEntry = { payload: string; expiresAt: number };
type FileShape = Record<string, StoredEntry>;
type StoreBackend = "unresolved" | "turso" | "file" | "memory";

const DDL =
  "CREATE TABLE IF NOT EXISTS share_tokens (token TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tursoClient: TursoClient | null | "unavailable" = null;
let tableReady = false;
let activeBackend: StoreBackend = "unresolved";
const fallbackMemory = new Map<string, StoredEntry>();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 512) : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeNonNegativeNumber(value: unknown, fallback = 0): number {
  return Math.max(0, safeNumber(value, fallback));
}

/**
 * Project untrusted input onto the exact BossReportData allowlist. This prevents extra body fields,
 * including raw scan rows or customer details, from becoming part of a public share artifact.
 */
export function normalizeBossReportSnapshot(input: unknown): BossReportData {
  const source = record(input) ?? {};
  const moat = record(source.moat) ?? {};

  const byBrand = Array.isArray(source.byBrand)
    ? source.byBrand.flatMap((value) => {
        const row = record(value);
        return row
          ? [{ brand: safeString(row.brand, "Unknown"), qty: safeNonNegativeNumber(row.qty) }]
          : [];
      })
    : [];

  const byCategory = Array.isArray(source.byCategory)
    ? source.byCategory.flatMap((value) => {
        const row = record(value);
        return row
          ? [{ category: safeString(row.category, "Uncategorized"), qty: safeNonNegativeNumber(row.qty) }]
          : [];
      })
    : [];

  const topVariances = Array.isArray(source.topVariances)
    ? source.topVariances.slice(0, 10).flatMap((value) => {
        const row = record(value);
        return row
          ? [
              {
                productId: safeString(row.productId),
                name: safeString(row.name),
                prevQty: safeNonNegativeNumber(row.prevQty),
                currQty: safeNonNegativeNumber(row.currQty),
                delta: safeNumber(row.delta),
              },
            ]
          : [];
      })
    : [];

  const totalValue =
    source.totalValue === null
      ? null
      : typeof source.totalValue === "number" && Number.isFinite(source.totalValue)
        ? Math.max(0, source.totalValue)
        : null;

  return {
    totalItems: safeNonNegativeNumber(source.totalItems),
    moat: {
      identified: safeNonNegativeNumber(moat.identified),
      total: safeNonNegativeNumber(moat.total),
    },
    byBrand,
    byCategory,
    totalValue,
    hasAnyCostData: source.hasAnyCostData === true && totalValue !== null,
    topVariances,
    sessionName: safeString(source.sessionName, "Untitled session"),
    countedBy: safeString(source.countedBy, "Owner"),
    countedAt: safeString(source.countedAt),
  };
}

async function getTursoClient(): Promise<TursoClient | null> {
  if (tursoClient === "unavailable") return null;
  if (tursoClient) return tursoClient;

  const creds = tursoCredentialsFromEnv();
  if (!creds) {
    tursoClient = "unavailable";
    return null;
  }

  try {
    tursoClient = await createTursoClient(creds);
    return tursoClient;
  } catch (error) {
    console.warn(
      "[shareTokenStore] Failed to create Turso client, using local fallback:",
      error instanceof Error ? error.message : String(error),
    );
    tursoClient = "unavailable";
    return null;
  }
}

async function ensureTable(client: TursoClient): Promise<boolean> {
  if (tableReady) return true;
  try {
    await client.execute({ sql: DDL, args: [] });
    tableReady = true;
    return true;
  } catch (error) {
    console.warn(
      "[shareTokenStore] Failed to ensure share_tokens table, using local fallback:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function fallbackFile(): string {
  return process.env.SHARE_TOKEN_FILE?.trim() || path.resolve(".share-tokens.json");
}

// Same production-detection convention as src/authentication/service/authBypass.ts: NODE_ENV === "production"
// is the sole signal, so this can never misfire in dev/test/CI. In production, Vercel's filesystem is
// ephemeral: the local-file fallback write is silently lost, which would hand out a share link that
// later 404s. Fail loud instead so the caller gets a 503 and never receives a broken token.
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function isMemoryFallback(): boolean {
  return fallbackFile() === ":memory:" || process.env.NODE_ENV === "test";
}

function readFallbackFile(): FileShape {
  try {
    const file = fallbackFile();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return record(parsed) ? (parsed as FileShape) : {};
  } catch {
    return {};
  }
}

function writeFallbackFile(data: FileShape): void {
  try {
    fs.writeFileSync(fallbackFile(), JSON.stringify(data), "utf8");
  } catch (error) {
    console.warn(
      "[shareTokenStore] Failed to write local share-token fallback:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function writeFallback(token: string, entry: StoredEntry): void {
  fallbackMemory.set(token, entry);
  if (isMemoryFallback()) {
    activeBackend = "memory";
    return;
  }

  activeBackend = "file";
  const data = readFallbackFile();
  data[token] = entry;
  writeFallbackFile(data);
}

function readFallback(token: string): StoredEntry | null {
  const memoryEntry = fallbackMemory.get(token);
  if (memoryEntry) {
    activeBackend = isMemoryFallback() ? "memory" : "file";
    return memoryEntry;
  }
  if (isMemoryFallback()) {
    activeBackend = "memory";
    return null;
  }

  activeBackend = "file";
  const entry = readFallbackFile()[token];
  if (!entry || typeof entry.payload !== "string" || !Number.isFinite(entry.expiresAt)) {
    return null;
  }
  fallbackMemory.set(token, entry);
  return entry;
}

function parseStoredPayload(entry: StoredEntry): SharePayload | null {
  try {
    const source = record(JSON.parse(entry.payload));
    if (!source) return null;

    const businessId = safeString(source.businessId);
    const sessionId = safeString(source.sessionId);
    const createdAt = safeNumber(source.createdAt, Number.NaN);
    const payloadExpiresAt = safeNumber(source.expiresAt, Number.NaN);
    const expiresAt = Math.min(entry.expiresAt, payloadExpiresAt);
    if (!businessId || !sessionId || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
      return null;
    }
    if (Date.now() >= expiresAt) return null;

    return {
      businessId,
      sessionId,
      reportSnapshot: normalizeBossReportSnapshot(source.reportSnapshot),
      createdAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

export async function mintShareToken(payload: SharePayload): Promise<string> {
  const token = randomUUID();
  const storedPayload: SharePayload = {
    businessId: payload.businessId,
    sessionId: payload.sessionId,
    reportSnapshot: normalizeBossReportSnapshot(payload.reportSnapshot),
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
  };
  const entry = {
    payload: JSON.stringify(storedPayload),
    expiresAt: storedPayload.expiresAt,
  };

  const client = await getTursoClient();
  if (client && (await ensureTable(client))) {
    try {
      await client.execute({
        sql: "INSERT INTO share_tokens (token, payload, expires_at) VALUES (?, ?, ?)",
        args: [token, entry.payload, entry.expiresAt],
      });
      activeBackend = "turso";
      return token;
    } catch (error) {
      console.warn(
        "[shareTokenStore] Turso insert failed, using local fallback:",
        error instanceof Error ? error.message : String(error),
      );
      // M1 (resilience nit): a durable WRITE failure means this client instance is bad (or the
      // connection has gone stale) - invalidate the memoization so the NEXT call re-attempts
      // construction from scratch instead of hammering the same known-bad client on every request.
      // This does not change F6's fail-loud outcome: the throw below (production) or the fallback
      // return (dev/test) still happens on THIS call exactly as before.
      tursoClient = null;
      tableReady = false;
    }
  }

  // Durable storage (Turso) was unavailable or the write failed. In production the only remaining
  // option is the local-file fallback, but Vercel's filesystem is ephemeral: that write never
  // survives past the current invocation, so the link handed back would 404 later with no trace.
  // Fail loud here instead of returning a token that silently rots.
  if (isProductionRuntime()) {
    throw new Error(
      "Durable share storage is unavailable. Share links cannot be created right now.",
    );
  }

  writeFallback(token, entry);
  return token;
}

export async function resolveShareToken(token: string): Promise<SharePayload | null> {
  if (!UUID_PATTERN.test(token)) return null;

  const client = await getTursoClient();
  if (client && (await ensureTable(client))) {
    try {
      const result = await client.execute({
        sql: "SELECT payload, expires_at FROM share_tokens WHERE token = ?",
        args: [token],
      });
      const row = result.rows[0];
      if (row) {
        activeBackend = "turso";
        return parseStoredPayload({
          payload: String(row.payload),
          expiresAt: Number(row.expires_at),
        });
      }
    } catch (error) {
      console.warn(
        "[shareTokenStore] Turso read failed, using local fallback:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const entry = readFallback(token);
  return entry ? parseStoredPayload(entry) : null;
}

/** Reset memoized backend state so unit tests can prove environment selection independently. */
export function __resetShareTokenStoreForTests(): void {
  tursoClient = null;
  tableReady = false;
  activeBackend = "unresolved";
  fallbackMemory.clear();
}

/** Exposes only the selected backend name for the fallback safety assertion. */
export function __getShareTokenStoreBackendForTests(): StoreBackend {
  return activeBackend;
}
