#!/usr/bin/env node
// Samples UPC/EAN codes WITH names from the Turso retail knowledge DB (schema-discovering).
// READ-ONLY against the production-shared Turso DB: SELECT/PRAGMA only, never write.
// Keys are read from .env.local at runtime and never printed.
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(HERE, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
const client = createClient({ url: get("TURSO_DATABASE_URL"), authToken: get("TURSO_AUTH_TOKEN") });

const tables = await client.execute(`SELECT name FROM sqlite_master WHERE type='table'`);
console.log("tables:", tables.rows.map((r) => r.name).join(", "));
// find a table with a barcode-ish and a name-ish column
let target = null;
for (const t of tables.rows.map((r) => String(r.name))) {
  const cols = (await client.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
  const codeCol = cols.find((c) => /barcode|upc|ean|gtin|^code$/i.test(c));
  const nameCol = cols.find((c) => /product_name|^name$|title/i.test(c));
  const brandCol = cols.find((c) => /brand/i.test(c)) ?? null;
  if (codeCol && nameCol) {
    target = { t, codeCol, nameCol, brandCol };
    break;
  }
}
if (!target) {
  console.error("no suitable table found - inspect schema manually");
  process.exit(1);
}
console.log("using", JSON.stringify(target));

// 45 US UPCs + ~25 foreign EANs (prefix not 0/1), random-ish spread, we keep ~35+12 after checks
const us = await client.execute(
  `SELECT ${target.codeCol} AS code, ${target.nameCol} AS name${target.brandCol ? `, ${target.brandCol} AS brand` : ""} FROM ${target.t} WHERE length(${target.codeCol}) IN (12,13) AND substr(${target.codeCol},1,1) IN ('0','1') AND ${target.nameCol} != '' ORDER BY rowid % 9973 LIMIT 45`
);
// `ORDER BY rowid % N` does not shuffle well when rows are stored in prefix-contiguous blocks:
// a plain "prefix NOT IN ('0','1')" query returned 25/25 rows from prefix '2' alone (US
// restricted-circulation numbers, not a real country prefix). Pull explicitly across several
// genuine GS1 country-prefix buckets (3=France, 4=Germany/Japan, 5=UK, 6, 7, 8=Italy/Netherlands,
// 9=Austria/Australia) so the foreign sample is actually international, not one degenerate prefix.
const FOREIGN_PREFIXES = ["3", "4", "5", "6", "7", "8", "9"];
const INTL_TARGET = 25;
const perPrefix = Math.ceil(INTL_TARGET / FOREIGN_PREFIXES.length);
let intlRows = [];
for (const p of FOREIGN_PREFIXES) {
  const r = await client.execute(
    `SELECT ${target.codeCol} AS code, ${target.nameCol} AS name${target.brandCol ? `, ${target.brandCol} AS brand` : ""} FROM ${target.t} WHERE length(${target.codeCol}) = 13 AND substr(${target.codeCol},1,1) = '${p}' AND ${target.nameCol} != '' ORDER BY rowid % 7919 LIMIT ${perPrefix}`
  );
  intlRows.push(...r.rows);
}
intlRows = intlRows.slice(0, INTL_TARGET);
const rows = [...us.rows, ...intlRows].map((r) => ({
  code: String(r.code),
  truth: `${r.brand ? r.brand + " " : ""}${r.name}`.trim(),
  source: `turso:${target.t}`,
}));
writeFileSync(join(HERE, "dryrun-candidates-retail.json"), JSON.stringify(rows, null, 2));
console.log(`wrote ${rows.length} retail candidates (${us.rows.length} US, ${intlRows.length} intl)`);
console.log(
  "NOTE: these codes already resolve free via the local retail knowledge layer before any AI call - they are here to test the LADDER itself (cheap-first grounding), not to prove new AI coverage."
);
