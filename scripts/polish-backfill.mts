// Offline deterministic backfill for structured product fields. It never calls a network provider.
// Accepted input shapes: Product[], { products: Product[] }, or a persisted Zustand snapshot.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backfillProducts } from "../src/products/polish/backfillProducts.ts";
import type { Product } from "../src/types.ts";

type SnapshotShape = "array" | "wrapped" | "persisted";

function extractProducts(raw: unknown): { products: Product[]; shape: SnapshotShape } {
  if (Array.isArray(raw)) return { products: raw as Product[], shape: "array" };
  const object = raw as { products?: Product[]; state?: { products?: Product[] } };
  if (object && Array.isArray(object.products)) return { products: object.products, shape: "wrapped" };
  if (object?.state && Array.isArray(object.state.products)) return { products: object.state.products, shape: "persisted" };
  throw new Error(
    'Input JSON must be a Product[] array, {"products":[...]}, or a persisted {"state":{"products":[...]}} snapshot.',
  );
}

function reinject(raw: unknown, shape: SnapshotShape, products: Product[]): unknown {
  if (shape === "array") return products;
  if (shape === "wrapped") return { ...(raw as Record<string, unknown>), products };
  const object = raw as { state: Record<string, unknown> };
  return { ...object, state: { ...object.state, products } };
}

function parseArgs(argv: string[]) {
  const fileIndex = argv.indexOf("--file");
  const outputIndex = argv.indexOf("--out");
  return {
    file: fileIndex >= 0 ? argv[fileIndex + 1] : undefined,
    output: outputIndex >= 0 ? argv[outputIndex + 1] : undefined,
    dryRun: argv.includes("--dry-run"),
  };
}

export async function run(argv: string[]): Promise<number> {
  const { file, output, dryRun } = parseArgs(argv);
  if (!file) {
    console.log("Usage: node scripts/polish-backfill.mts --file <snapshot.json> [--dry-run] [--out <path>]");
    return 1;
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  const { products, shape } = extractProducts(raw);
  const { products: structured, changedIds, skippedHumanIds } = backfillProducts(products);

  console.log(`polish-backfill: ${products.length} product(s) read from ${file} (shape=${shape})`);
  console.log(`  would change: ${changedIds.length}`);
  console.log(`  skipped (structuredBy=human): ${skippedHumanIds.length}`);
  for (const id of changedIds) {
    const before = products.find((product) => product.id === id)!;
    const after = structured.find((product) => product.id === id)!;
    console.log(
      `  [${id}] "${before.name}" -> brand="${after.structuredBrand ?? ""}" model="${after.structuredModel ?? ""}" size="${after.sizeTag ?? ""}"`,
    );
  }

  if (dryRun) {
    console.log("Dry run: no file written.");
    return 0;
  }
  if (changedIds.length === 0) {
    console.log("Nothing to write (already up to date). ");
    return 0;
  }
  const outputFile = output ?? file;
  writeFileSync(outputFile, JSON.stringify(reinject(raw, shape, structured), null, 2));
  console.log(`Wrote ${outputFile}`);
  return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
