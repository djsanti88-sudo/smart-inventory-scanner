import { readFileSync } from "node:fs";

import { hasCountableTireIdentity } from "../src/services/ai/tireSpecs.ts";
import { prettifyBrand, prettifyProductName } from "../src/services/format/productDisplay.ts";
import { resolveRawScan } from "../src/services/resolver.ts";
import { normalizeTrustedCorpusTireSize } from "../src/services/tire/tireSizeNormalizer.ts";
import { isTrustedLocalDemoTireRow } from "../src/server/tire-knowledge/localDemoTrust.mjs";
import { DEMO_BUSINESS_ID, getSeed } from "../src/seed/seedData.ts";

type LocalDemoRow = Record<string, unknown>;

const builtInSeed = getSeed();
type LocalDemoSeed = typeof builtInSeed;

function text(value: unknown) {
  return String(value ?? "").trim();
}

/** Rebuild the display and identity text used by TireKnowledgeProvider.toResult. */
export function reconstructLocalDemoProviderIdentity(row: LocalDemoRow) {
  const displaySize = normalizeTrustedCorpusTireSize({
    size: text(row.size),
    rawSizeText: text(row.raw_size_text),
    model: text(row.model),
    modelDisplay: text(row.model_display),
  }) ?? text(row.size);
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

export function resolvesKnownAgainstLocalDemoSeed(
  row: LocalDemoRow,
  seed: LocalDemoSeed = builtInSeed,
): boolean {
  const resolution = resolveRawScan(
    text(row.barcode),
    seed.products,
    seed.aliases,
    DEMO_BUSINESS_ID,
  );
  return resolution.resolverStatus === "known";
}

/**
 * Ask the production countability gate against the exact provider display
 * identity. This deliberately does not add a manifest-only parser or accept a
 * size the scanner itself would reject.
 */
export function isCountableLocalDemoRow(row: LocalDemoRow, seed: LocalDemoSeed = builtInSeed): boolean {
  if (!isTrustedLocalDemoTireRow(row)) return false;
  // The local store resolves its built-in seed before the tire corpus. Only a
  // definitive seed Known result shadows this row; a conflict is not proof of
  // either seed identity and must remain eligible for corpus certification.
  if (resolvesKnownAgainstLocalDemoSeed(row, seed)) return false;

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
