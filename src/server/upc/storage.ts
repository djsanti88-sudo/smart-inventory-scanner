import "server-only";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

// Ladder storage seam. SERVER-SIDE ONLY.
//
// The Go-UPC rung needs three durable stores: a monthly usage counter (Task 5),
// a negative miss-cache keyed by canonical GTIN (Task 7), and an append-only raw
// decode archive (Task 2). Tasks 2, 5, and 7 consume ONLY this interface -- never
// fs directly -- so the Turso adapter (Task 21) swaps in without touching rung logic.
//
// The file-backed adapter is for local dev + Vercel preview only. Vercel production
// MUST NOT ship on it: function-instance file writes are ephemeral there (the
// "Knowledge DB dead on Vercel" lesson). Production uses the Turso adapter.

/** Monthly Go-UPC usage counter. `month` is a `YYYY-MM` key. */
export interface UsageState {
  month: string;
  used: number;
}

/** A negative-cache entry: a canonical GTIN that Go-UPC returned a genuine miss for. */
export interface MissEntry {
  canonical: string;
  missedAt: string;
  ttlDays: number;
}

/** One archived paid-decode response (raw JSON + provenance). Purge-proof evidence. */
export interface DecodeArchiveEntry {
  code: string;
  canonicalGtin: string;
  provider: "go-upc" | "fetchv2" | "gpt-5.5";
  httpStatus?: number;
  raw: unknown;
  sourceUrls?: string[];
  fetchedAt: string;
}

export interface LadderStorage {
  readUsage(): UsageState;
  writeUsage(s: UsageState): void;
  readMissCache(key: string): MissEntry | null;
  writeMissCache(key: string, e: MissEntry): void;
  appendArchive(entry: DecodeArchiveEntry): void;
}

const USAGE_FILE = ".go-upc-usage.json";
const MISS_FILE = ".go-upc-miss-cache.json";
const ARCHIVE_SUBDIR = "decode-archive";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/** Read + JSON.parse a file, returning `fallback` on missing file or corrupt JSON (never throws). */
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    console.warn(`[ladderStorage] corrupt JSON at ${path}, using default:`, err);
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/**
 * File-backed LadderStorage under `dir`:
 *  - usage  -> `<dir>/.go-upc-usage.json`         (JSON `{ month, used }`)
 *  - miss   -> `<dir>/.go-upc-miss-cache.json`     (JSON map `{ [canonical]: MissEntry }`)
 *  - archive-> `<dir>/decode-archive/<YYYY-MM>.jsonl` (append-only JSONL, bucketed by entry month)
 * The dir is created lazily on first write. Reads of corrupt data degrade to defaults with a warn.
 */
export function fileLadderStorage(dir: string): LadderStorage {
  const usagePath = join(dir, USAGE_FILE);
  const missPath = join(dir, MISS_FILE);
  const archiveDir = join(dir, ARCHIVE_SUBDIR);

  function ensureDir(target: string): void {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  }

  return {
    readUsage(): UsageState {
      return readJson<UsageState>(usagePath, { month: currentMonth(), used: 0 });
    },

    writeUsage(s: UsageState): void {
      ensureDir(dir);
      writeJson(usagePath, s);
    },

    readMissCache(key: string): MissEntry | null {
      const map = readJson<Record<string, MissEntry>>(missPath, {});
      return map[key] ?? null;
    },

    writeMissCache(key: string, e: MissEntry): void {
      ensureDir(dir);
      const map = readJson<Record<string, MissEntry>>(missPath, {});
      map[key] = e;
      writeJson(missPath, map);
    },

    appendArchive(entry: DecodeArchiveEntry): void {
      ensureDir(archiveDir);
      const month = entry.fetchedAt.slice(0, 7); // YYYY-MM from fetchedAt
      const monthFile = join(archiveDir, `${month}.jsonl`);
      appendFileSync(monthFile, JSON.stringify(entry) + "\n", "utf8");
    },
  };
}
