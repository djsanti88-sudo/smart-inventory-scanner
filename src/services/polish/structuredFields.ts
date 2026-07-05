// Build 2 / Task 4: the single deterministic-structuring call site shared by the hot path
// (product create / name-update inside scanStore.ts) and the offline backfill script. Pure,
// no React/next imports, no network - matches the CLAUDE.md "services stay pure and testable"
// convention and reuses the Task 1 structurer (never re-implements parsing here).

// NOTE: relative + explicit ".ts" extensions (not the usual "@/" alias) so this module's own import
// chain also resolves under plain `node` (no bundler) when scripts/polish-backfill.mts imports it
// directly - the "@/" tsconfig path alias is bundler/vitest-only and is NOT understood by Node's
// native ESM resolver. App code still imports THIS file via "@/services/polish/structuredFields"
// as normal; only its internal imports need to stay Node-resolvable.
import { structureProduct } from "./structurer.ts";
import type { Product } from "../../types.ts";

export type StructuredFieldsPatch = Pick<
  Product,
  "structuredBrand" | "structuredModel" | "structuredDescription" | "sizeTag" | "structuredBy"
>;

/**
 * Deterministic-only structuring (never calls the LLM fallback - that stays a background/backfill
 * concern per CLAUDE.md, never on the hot path). Returns the patch to merge onto a Product.
 *
 * Guard: when `previousStructuredBy` is "human", returns an EMPTY patch. A human's correction
 * (via correctProduct) must never be silently clobbered by a later automatic re-structuring pass -
 * same "never overwrite a human decision" principle as the Resolver Trust Rules.
 */
export function structuredFieldsFor(
  name: string,
  brand: string,
  previousStructuredBy?: Product["structuredBy"],
): Partial<StructuredFieldsPatch> {
  if (previousStructuredBy === "human") return {};
  const s = structureProduct(name, brand || undefined);
  return {
    structuredBrand: s.brand || undefined,
    structuredModel: s.model || undefined,
    structuredDescription: s.descriptionText || undefined,
    sizeTag: s.sizeTag || undefined,
    structuredBy: "deterministic",
  };
}
