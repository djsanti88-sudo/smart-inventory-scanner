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

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backfillProducts } from "../src/services/polish/backfillProducts.ts";
import type { Product } from "../src/types.ts";

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
  };
}

export function run(argv: string[]): number {
  const { file, out, dryRun } = parseArgs(argv);
  if (!file) {
    console.log("Usage: node scripts/polish-backfill.mts --file <snapshot.json> [--dry-run] [--out <path>]");
    console.log("See the header comment for the accepted JSON shapes and the persistence approach.");
    return 1;
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const { products, shape } = extractProducts(raw);
  const { products: updated, changedIds, skippedHumanIds } = backfillProducts(products);

  console.log(`polish-backfill: ${products.length} product(s) read from ${file} (shape=${shape})`);
  console.log(`  would change: ${changedIds.length}`);
  console.log(`  skipped (structuredBy=human): ${skippedHumanIds.length}`);
  for (const id of changedIds) {
    const before = products.find((p) => p.id === id)!;
    const after = updated.find((p) => p.id === id)!;
    console.log(
      `  [${id}] "${before.name}" -> brand="${after.structuredBrand ?? ""}" model="${after.structuredModel ?? ""}" size="${after.sizeTag ?? ""}"`,
    );
  }

  if (dryRun) {
    console.log("Dry run: no file written.");
    return 0;
  }
  if (changedIds.length === 0) {
    console.log("Nothing to write (already up to date).");
    return 0;
  }
  const outFile = out ?? file;
  writeFileSync(outFile, JSON.stringify(reinject(raw, shape, updated), null, 2));
  console.log(`Wrote ${outFile}`);
  return 0;
}

// ESM entry-point guard: only run the CLI when this file is executed directly (`node
// scripts/polish-backfill.mts ...`), not when its exports are imported by a test. Uses
// pathToFileURL for correctness on Windows (raw string concatenation mishandles the drive letter).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = run(process.argv.slice(2));
}
