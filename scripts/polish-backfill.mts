// scripts/polish-backfill.mts
// Build 2 / Task 4: offline backfill CLI for the deterministic structured-product fields
// (structuredBrand / structuredModel / structuredDescription / sizeTag / structuredBy).
//
// PERSISTENCE NOTE (read before running):
// Smart Inventory's local/mock mode keeps products ONLY in the browser's localStorage, under the
// Zustand persist key "sis-scan-v1" (src/stores/scanStore.ts) - there is no server-side JSON file
// or DB this app seeds products from, so a Node script cannot reach a real user's data directly.
// Because of that, the PRIMARY backfill mechanism for real users is the persist `migrate` step
// wired into scanStore.ts (bumped v5 -> v6): every existing product gets structured fields the next
// time the app loads, automatically, applying the exact same rule this script uses (skip any row
// already marked structuredBy: "human") via the shared pure helper backfillProducts()
// (src/services/polish/backfillProducts.ts).
//
// This CLI is the offline/JSON-snapshot companion - useful for a support ticket's exported state, a
// future Firestore export batch, or CI auditing. It reads a JSON file containing:
//   - a plain Product[] array, OR
//   - { products: Product[] }, OR
//   - a raw persisted zustand snapshot { state: { products: Product[] }, version }
//     (e.g. the literal value of `localStorage.getItem("sis-scan-v1")`)
// and applies the same idempotent, skip-human backfill.
//
// Usage:
//   node scripts/polish-backfill.mts --file path/to/snapshot.json                 # writes changes in place
//   node scripts/polish-backfill.mts --file path/to/snapshot.json --dry-run       # prints changes only, writes nothing
//   node scripts/polish-backfill.mts --file path/to/snapshot.json --out out.json  # write to a different file
//   node scripts/polish-backfill.mts --file path/to/snapshot.json --llm           # ALSO run the LLM fallback
//
// --llm (Task 4 review fix): after the deterministic pass above, rows the structurer marked
// low-confidence (< 0.6, see backfillLlm.ts) AND not locked by a human correction are additionally
// polished by Gemini Flash-Lite (src/services/polish/llmPolish.ts geminiPolishProvider). The key is
// read SERVER-SIDE ONLY from GEMINI_API_KEY (checked in process.env, then .env.local) - per
// CLAUDE.md this is a live paid call, so it is gated behind this explicit flag AND a configured key.
// Without a key, --llm just REPORTS how many rows are LLM-eligible and skips (no live call, no crash).
// Results stamp structuredBy "llm" + the LLM's confidence; the deterministic tireSizeTag still always
// wins (polishWithLlm recomputes and overrides it internally - never trust the LLM's own tire tag).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backfillProducts } from "../src/services/polish/backfillProducts.ts";
import { isLlmEligible, backfillWithLlm, LLM_ELIGIBLE_CONFIDENCE_THRESHOLD } from "../src/services/polish/backfillLlm.ts";
import { geminiPolishProvider } from "../src/services/polish/llmPolish.ts";
import type { Product } from "../src/types.ts";

/** .env.local -> process.env (values never logged), matching the pattern used by the other live-call
 *  scripts in this repo (e.g. gpt-ladder-live-proof.mts). Silently a no-op when the file is absent
 *  (CI, a machine with no local secrets) - GEMINI_API_KEY simply stays unset and --llm reports+skips.
 *
 *  HARD SAFETY GUARD: never read the real .env.local under Vitest (which always sets
 *  process.env.VITEST). Without this, a unit test that deletes process.env.GEMINI_API_KEY to
 *  simulate "no key configured" would have this loader silently refill it from the real secrets
 *  file, letting an automated test construct the LIVE Gemini provider and attempt a real network
 *  call - exactly what the Engineering Doctrine's "automated tests never call live providers" rule
 *  and CLAUDE.md's AI workflow rules forbid. Real .env.local is only ever read for an actual `node
 *  scripts/polish-backfill.mts --llm` invocation outside the test runner. */
function loadDotEnvLocal(): void {
  if (process.env.VITEST) return;
  try {
    const url = new URL("../.env.local", import.meta.url);
    if (!existsSync(url)) return;
    for (const line of readFileSync(url, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env.local reachable - fine, GEMINI_API_KEY simply stays unset
  }
}

type SnapshotShape = "array" | "wrapped" | "persisted";

function extractProducts(raw: unknown): { products: Product[]; shape: SnapshotShape } {
  if (Array.isArray(raw)) return { products: raw as Product[], shape: "array" };
  const obj = raw as { products?: Product[]; state?: { products?: Product[] } };
  if (obj && Array.isArray(obj.products)) return { products: obj.products, shape: "wrapped" };
  if (obj && obj.state && Array.isArray(obj.state.products)) return { products: obj.state.products, shape: "persisted" };
  throw new Error(
    'Input JSON must be a Product[] array, {"products":[...]}, or a persisted {"state":{"products":[...]}} snapshot.',
  );
}

function reinject(raw: unknown, shape: SnapshotShape, products: Product[]): unknown {
  if (shape === "array") return products;
  if (shape === "wrapped") return { ...(raw as Record<string, unknown>), products };
  const obj = raw as { state: Record<string, unknown> };
  return { ...obj, state: { ...obj.state, products } };
}

function parseArgs(argv: string[]) {
  const fileIdx = argv.indexOf("--file");
  const outIdx = argv.indexOf("--out");
  return {
    file: fileIdx >= 0 ? argv[fileIdx + 1] : undefined,
    out: outIdx >= 0 ? argv[outIdx + 1] : undefined,
    dryRun: argv.includes("--dry-run"),
    llm: argv.includes("--llm"),
  };
}

export async function run(argv: string[]): Promise<number> {
  const { file, out, dryRun, llm } = parseArgs(argv);
  if (!file) {
    console.log("Usage: node scripts/polish-backfill.mts --file <snapshot.json> [--dry-run] [--out <path>] [--llm]");
    console.log("See the header comment for the accepted JSON shapes, the persistence approach, and --llm.");
    return 1;
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const { products, shape } = extractProducts(raw);
  const { products: deterministic, changedIds, skippedHumanIds } = backfillProducts(products);

  console.log(`polish-backfill: ${products.length} product(s) read from ${file} (shape=${shape})`);
  console.log(`  would change: ${changedIds.length}`);
  console.log(`  skipped (structuredBy=human): ${skippedHumanIds.length}`);
  for (const id of changedIds) {
    const before = products.find((p) => p.id === id)!;
    const after = deterministic.find((p) => p.id === id)!;
    console.log(
      `  [${id}] "${before.name}" -> brand="${after.structuredBrand ?? ""}" model="${after.structuredModel ?? ""}" size="${after.sizeTag ?? ""}"`,
    );
  }

  let finalProducts = deterministic;
  let llmChangedCount = 0;
  const eligibleIds = deterministic.filter(isLlmEligible).map((p) => p.id);

  if (llm && process.env.VITEST) {
    // HARD SAFETY GUARD (defense in depth, see loadDotEnvLocal's comment): even if GEMINI_API_KEY
    // happens to be set directly in the ambient environment (not via .env.local), the live provider
    // must NEVER be constructed while running under the test runner. No automated test may make a
    // real network call.
    console.log(
      `  --llm skipped: running under the test runner (VITEST) - live providers are never called from automated tests. ` +
        `${eligibleIds.length} row(s) would be LLM-eligible (confidence < ${LLM_ELIGIBLE_CONFIDENCE_THRESHOLD}).`,
    );
  } else if (llm) {
    loadDotEnvLocal();
    const apiKey = process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) {
      console.log(
        `  --llm requested but GEMINI_API_KEY is not configured (checked process.env + .env.local): ` +
          `${eligibleIds.length} row(s) are LLM-eligible (confidence < ${LLM_ELIGIBLE_CONFIDENCE_THRESHOLD}) - skipped, no live call made.`,
      );
    } else {
      console.log(
        `  --llm: ${eligibleIds.length} row(s) eligible (confidence < ${LLM_ELIGIBLE_CONFIDENCE_THRESHOLD}); polishing via Gemini...`,
      );
      const provider = geminiPolishProvider();
      const { products: llmResult, llmChangedIds } = await backfillWithLlm(deterministic, {
        provider,
        cache: new Map(),
      });
      finalProducts = llmResult;
      llmChangedCount = llmChangedIds.length;
      console.log(`  LLM polished: ${llmChangedCount} row(s)`);
    }
  } else {
    console.log(
      `  LLM-eligible (confidence < ${LLM_ELIGIBLE_CONFIDENCE_THRESHOLD}): ${eligibleIds.length} row(s). ` +
        `Pass --llm (with GEMINI_API_KEY set) to run the LLM fallback on them.`,
    );
  }

  if (dryRun) {
    console.log("Dry run: no file written.");
    return 0;
  }
  if (changedIds.length === 0 && llmChangedCount === 0) {
    console.log("Nothing to write (already up to date).");
    return 0;
  }
  const outFile = out ?? file;
  writeFileSync(outFile, JSON.stringify(reinject(raw, shape, finalProducts), null, 2));
  console.log(`Wrote ${outFile}`);
  return 0;
}

// ESM entry-point guard: only run the CLI when this file is executed directly (`node
// scripts/polish-backfill.mts ...`), not when its exports are imported by a test. Uses
// pathToFileURL for correctness on Windows (raw string concatenation mishandles the drive letter).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
