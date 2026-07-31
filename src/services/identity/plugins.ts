import { jaccard, nameTokens } from "@/services/catalog/identityMerge";
import { normalizeCategory, normalizePluginInput, tireIdentityPlugin } from "./tirePlugin";
import type { IdentityCandidate, IdentityInput } from "./types";

export type ConstraintResult =
  | { outcome: "pass"; corroborated: string[]; missing: string[] }
  | { outcome: "reject"; contradictions: string[]; missing: string[] };

export interface SemanticFeatures {
  score: number;
  orderedFeatureScores: Array<{ feature: string; score: number }>;
  /** Semantic similarity is only candidate-ranking evidence; it never permits automatic matching. */
  automaticEligible: false;
}

export interface IdentityCategoryPlugin {
  category: string;
  version: string;
  normalize(input: IdentityInput): IdentityInput;
  deterministicKeys(input: IdentityInput): string[];
  hardConstraints(input: IdentityInput, candidate: IdentityCandidate): ConstraintResult;
  semanticFeatures(input: IdentityInput, candidate: IdentityCandidate): SemanticFeatures;
}

function textFor(input: Pick<IdentityInput, "title" | "description">): string {
  return [input.title, input.description].filter(Boolean).join(" ");
}

export const genericIdentityPlugin: IdentityCategoryPlugin = {
  category: "generic",
  version: "identity-generic-v1",

  normalize(input) {
    return normalizePluginInput(input);
  },

  deterministicKeys(input) {
    return input.identifiers.map((identifier) => JSON.stringify([identifier.type, identifier.namespace ?? "", identifier.normalized]));
  },

  hardConstraints(input, candidate) {
    const inputCategory = normalizeCategory(input.categoryHint);
    const candidateCategory = normalizeCategory(candidate.category);
    if (inputCategory && candidateCategory && inputCategory !== candidateCategory) {
      return {
        outcome: "reject",
        contradictions: [`category_mismatch:${inputCategory}!=${candidateCategory}`],
        missing: [],
      };
    }
    return {
      outcome: "pass",
      corroborated: inputCategory && candidateCategory ? [`category:${inputCategory}`] : [],
      missing: inputCategory && candidateCategory ? [] : ["category"],
    };
  },

  semanticFeatures(input, candidate) {
    const score = jaccard(nameTokens(textFor(input)), nameTokens(candidate.title ?? ""));
    return { score, orderedFeatureScores: [{ feature: "text_jaccard_review_only", score }], automaticEligible: false };
  },
};

export function pluginFor(input: IdentityInput): IdentityCategoryPlugin {
  return input.categoryHint?.trim().toLowerCase() === "tire" || input.categoryHint?.trim().toLowerCase() === "tires"
    ? tireIdentityPlugin
    : genericIdentityPlugin;
}
