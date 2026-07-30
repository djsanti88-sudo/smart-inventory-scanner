import { readFileSync } from "node:fs";

import { hasCountableTireIdentity } from "../src/services/ai/tireSpecs.ts";
import { prettifyBrand, prettifyProductName } from "../src/services/format/productDisplay.ts";
import { normalizeTireSize } from "../src/services/tire/tireSizeNormalizer.ts";
import { isTrustedLocalDemoTireRow } from "../src/server/tire-knowledge/localDemoTrust.mjs";

type LocalDemoRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}

/** Rebuild the display and identity text used by TireKnowledgeProvider.toResult. */
export function reconstructLocalDemoProviderIdentity(row: LocalDemoRow) {
  const displaySize = normalizeTireSize(text(row.size))?.split(" ")[0] ?? text(row.size);
  const loadSpeed = [text(row.load_index), text(row.speed_rating)].filter(Boolean).join("");
  const specs = [displaySize, loadSpeed].filter(Boolean).join(" ");
  const brand = prettifyBrand(text(row.brand));
  const model = prettifyProductName(text(row.model_display) || text(row.model));
  const productName = [brand, model, specs].filter(Boolean).join(" ");
  return { displaySize, specs, brand, model, productName };
}

export function projectLocalDemoProviderRow(row: LocalDemoRow): LocalDemoRow {
  return { ...row, size: reconstructLocalDemoProviderIdentity(row).displaySize };
}

/**
 * Ask the production countability gate against the exact provider display
 * identity. This deliberately does not add a manifest-only parser or accept a
 * size the scanner itself would reject.
 */
export function isCountableLocalDemoRow(row: LocalDemoRow): boolean {
  if (!isTrustedLocalDemoTireRow(row)) return false;

  const { specs, brand, productName } = reconstructLocalDemoProviderIdentity(row);

  return hasCountableTireIdentity({ productName, brand, category: "Tire", specsShort: specs });
}

export function countableLocalDemoRowIndexes(rows: unknown[]): number[] {
  return rows.flatMap((row, index) => (
    row && typeof row === "object" && !Array.isArray(row) && isCountableLocalDemoRow(row as LocalDemoRow)
      ? [index]
      : []
  ));
}

if (process.argv[2] === "--stdin-json") {
  const parsed: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Local demo countability input must be an array.");
  process.stdout.write(JSON.stringify(countableLocalDemoRowIndexes(parsed)));
}
