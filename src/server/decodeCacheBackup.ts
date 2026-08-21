// Task 20 (owner-ratified 2026-07-15, pay-once durability): a Turso decode_cache wipe would force
// re-paying every un-approved paid decode all over again. The archive keeps raw provider data but is
// not a lookup rung, and corpus write-back of AI guesses is explicitly out of scope (trust firewall -
// the corpus is ground truth, machine guesses must never become indistinguishable from it). The
// proportionate fix is a faithful, boring dump/restore of the decode_cache rows themselves.
//
// This module is PURE (no I/O, no fs, no network) - it only knows how to serialize/deserialize
// PersistedDecode rows as JSON Lines (one JSON object per physical line). The CLI script
// (scripts/decode-cache-backup.mjs) owns reading rows from Turso/file storage and writing/reading the
// backup file; it calls into this module for the format.
//
// Corruption tolerance is a hard requirement: a backup file is a human/ops artifact that can be
// hand-edited, partially written, or truncated. parseBackup NEVER throws - a bad line (invalid JSON,
// or valid JSON with the wrong shape) is silently skipped so its valid neighbors still restore.
import type { PersistedDecode } from "@/server/decodeCacheStore";

/** Serialize rows to JSON Lines: one JSON object per line, no trailing content on empty input. */
export function exportDecodeCache(rows: PersistedDecode[]): string {
  if (!rows || rows.length === 0) return "";
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function isValidPersistedDecode(v: unknown): v is PersistedDecode {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    e.code.length > 0 &&
    // Legacy "no_result_receipt" lines from pre-abolition backups (owner 2026-08-20) are skipped -
    // restoring one would resurrect a no-candidate row.
    e.kind === "result" &&
    typeof e.payload === "string" &&
    typeof e.tier === "string" &&
    typeof e.createdAt === "number"
  );
}

/**
 * Parse a JSON Lines backup back into rows. Per-line JSON.parse + shape validation; a corrupt or
 * wrong-shape line is skipped, never thrown - valid neighbor lines still survive.
 */
export function parseBackup(jsonl: string): PersistedDecode[] {
  const rows: PersistedDecode[] = [];
  if (!jsonl) return rows;
  const lines = jsonl.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // corrupt line - skip, never throw
    }
    if (!isValidPersistedDecode(parsed)) continue; // wrong shape - skip, never throw
    rows.push({
      code: parsed.code,
      kind: parsed.kind,
      payload: parsed.payload,
      tier: parsed.tier,
      createdAt: parsed.createdAt,
    });
  }
  return rows;
}
