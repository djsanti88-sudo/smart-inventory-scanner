import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { normalizeTireSize } from "@/services/tire/tireSizeNormalizer";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const authoritative = "C:/Users/djsan/inventory/backups/claude-tire-db-handoff-2026-07-28/repair-2026-07-28/REPAIRED_TIRE_DATABASE.db";
function nodeNormalize(value: string): string | null { const source="import('./scripts/tire-db-repair/12_same_uid_blank_propagation.mjs').then(m=>process.stdout.write(m.normalizeSize(process.argv[1])))"; const out=execFileSync(process.execPath,["-e",source,value],{cwd:process.cwd(),encoding:"utf8"}).trim(); return out || null; }

describe("same-UID repair size normalizer parity", () => {
  it("matches the shared normalizer for every authoritative candidate donor and adversaries", () => {
    const db = new Database(authoritative, { readonly: true, fileMustExist: true });
    const candidates = db.prepare(`SELECT DISTINCT s.size FROM tires t JOIN tires s ON s.canonical_product_uid=t.canonical_product_uid WHERE TRIM(COALESCE(t.size,''))='' AND TRIM(COALESCE(s.size,''))<>'' ORDER BY s.size`).all().map((x: { size: string }) => x.size);
    db.close();
    for (const value of [...candidates, "not a tire", "35X12.50R17JUNK", "235/40R19XL", "265/70R17", "245/65-17"]) expect(nodeNormalize(value), value).toBe(normalizeTireSize(value));
  });
});
