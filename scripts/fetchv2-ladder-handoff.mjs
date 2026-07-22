// Ladder-handoff export: pulls every Fetch V2 row that did NOT verify (needs_review / unknown /
// rejected under v2Outcome) out of a full dry-run artifact and packages it, with any known
// no-result receipt, for the next ladder stage to pick up. Read-only over existing local JSON
// artifacts - no network, no live provider calls.
//
// Usage (run from the repo root):
//   node scripts/fetchv2-ladder-handoff.mjs
//   node scripts/fetchv2-ladder-handoff.mjs --input=scripts/fetchv2-v22-full.json --output=scripts/fetchv2-ladder-handoff.json
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const HANDOFF_OUTCOMES = new Set(["needs_review", "unknown", "rejected"]);
const RECEIPTS_PATH = "scripts/fetchv2-noresult-receipts.json";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const load = (relPath) => JSON.parse(readFileSync(resolve(process.cwd(), relPath), "utf8"));

function main() {
  const inputPath = argValue("input", "scripts/fetchv2-v22-full.json");
  const outputPath = argValue("output", "scripts/fetchv2-ladder-handoff.json");

  const full = load(inputPath);
  const rows = Array.isArray(full) ? full : full.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`No rows array found in ${inputPath} (expected top-level array or { rows: [...] })`);
  }

  let receipts = {};
  try {
    receipts = load(RECEIPTS_PATH);
  } catch (err) {
    console.warn(`fetchv2-ladder-handoff: could not load ${RECEIPTS_PATH} (${err.message}); all receipts will be null`);
  }

  const handoff = rows
    .filter((r) => HANDOFF_OUTCOMES.has(r.v2Outcome))
    .map((r) => ({
      code: r.code,
      group: r.group,
      outcome: r.v2Outcome,
      bestCandidate: r.product,
      sources: r.sources ?? [],
      receipt: receipts[r.code] ?? null,
    }));

  writeFileSync(resolve(process.cwd(), outputPath), JSON.stringify(handoff, null, 2));
  console.log(`fetchv2-ladder-handoff: ${handoff.length} row(s) written to ${outputPath} (from ${rows.length} input rows, input=${inputPath})`);
}

main();
