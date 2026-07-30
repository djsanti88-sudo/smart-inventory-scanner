// Build 2 / Task 4 polish-review fix: eligibility + application logic for the LLM polish backfill
// (scripts/polish-backfill.mts --llm). Extracted into its own pure module so vitest can cover the
// eligibility/stamping rules with an INJECTED mock provider - the live Gemini provider
// (geminiPolishProvider, src/services/polish/llmPolish.ts) is never constructed by any test.
//
// Per CLAUDE.md: "the LLM fallback is a background/backfill concern, never blocks a scan." This
// module is ONLY ever called from the offline backfill CLI, never from the scanStore hot path.
//
// NOTE: relative + explicit ".ts" extensions - this module's own import chain must also resolve
// under plain `node` when scripts/polish-backfill.mts imports it directly (see structuredFields.ts
// for the full rationale). App code may still import this file via the "@/" alias as normal.
import { polishWithLlm, type LlmPolishDeps } from "./llmPolish.ts";
import type { Product } from "../../types.ts";

/** Rows whose deterministic-structurer confidence falls below this are eligible for the LLM
 *  fallback (mirrors the threshold documented on StructuredProduct.confidence). */
export const LLM_ELIGIBLE_CONFIDENCE_THRESHOLD = 0.6;

/**
 * A product is LLM-eligible when:
 *  - it has ALREADY been through the deterministic pass (structuredConfidence is a number) - this
 *    backfill always runs backfillProducts() first, so eligibility is decided on its OUTPUT, not
 *    on raw/unstructured input; and
 *  - that confidence is below the threshold; and
 *  - it is not locked by a human correction (structuredBy: "human" is a permanent lock, same rule
 *    as structuredFieldsFor's own guard - never overwrite a human decision).
 */
export function isLlmEligible(product: Product): boolean {
  if (product.structuredBy === "human" || product.structuredBy === "trusted_corpus") return false;
  if (typeof product.structuredConfidence !== "number") return false;
  return product.structuredConfidence < LLM_ELIGIBLE_CONFIDENCE_THRESHOLD;
}

export interface LlmBackfillResult {
  products: Product[];
  eligibleIds: string[];
  llmChangedIds: string[];
}

/**
 * Runs polishWithLlm for every LLM-eligible row (see isLlmEligible) and stamps a successful result
 * as structuredBy "llm" + the LLM's own confidence. A failed/null polish (contained inside
 * polishWithLlm - bad JSON, provider error, etc.) leaves the row exactly as the deterministic pass
 * left it. The deterministic tireSizeTag ALWAYS wins over anything the LLM proposes - polishWithLlm
 * already recomputes and overrides it internally, so no extra work is needed here.
 */
export async function backfillWithLlm(products: Product[], deps: LlmPolishDeps): Promise<LlmBackfillResult> {
  const eligibleIds: string[] = [];
  const llmChangedIds: string[] = [];
  const updated: Product[] = [];

  for (const p of products) {
    if (!isLlmEligible(p)) {
      updated.push(p);
      continue;
    }
    eligibleIds.push(p.id);

    const result = await polishWithLlm(p.name, deps);
    if (!result) {
      updated.push(p);
      continue;
    }

    llmChangedIds.push(p.id);
    updated.push({
      ...p,
      structuredBrand: result.brand || undefined,
      structuredModel: result.model || undefined,
      structuredDescription: result.descriptionText || undefined,
      sizeTag: result.sizeTag || undefined,
      structuredBy: "llm",
      structuredConfidence: result.confidence,
    });
  }

  return { products: updated, eligibleIds, llmChangedIds };
}
