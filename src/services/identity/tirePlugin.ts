import { tireLoadSpeedToken, tireSizeToken } from "@/services/ai/tireSpecs";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";
import { jaccard, nameTokens, plusGenerationDiff } from "@/services/catalog/identityMerge";
import type { ConstraintResult, IdentityCategoryPlugin } from "./plugins";
import type { IdentityCandidate, IdentityInput } from "./types";

function textFor(input: Pick<IdentityInput, "title" | "description">): string {
  return [input.title, input.description].filter(Boolean).join(" ");
}

function candidateText(candidate: IdentityCandidate): string {
  return candidate.title ?? "";
}

function loadSpeedFor(record: Pick<IdentityInput | IdentityCandidate, "attributes">, text: string): string {
  return record.attributes.loadSpeed?.trim().toUpperCase() || tireLoadSpeedToken({ productName: text });
}

function constraintResult(
  contradictions: string[],
  corroborated: string[],
  missing: string[],
): ConstraintResult {
  return contradictions.length > 0
    ? { outcome: "reject", contradictions, missing }
    : { outcome: "pass", corroborated, missing };
}

export const tireIdentityPlugin: IdentityCategoryPlugin = {
  category: "tire",
  version: "identity-tire-v1",

  normalize(input) {
    return { ...input, brand: input.brand?.trim(), title: input.title?.trim(), description: input.description?.trim() };
  },

  deterministicKeys(input) {
    return input.identifiers.map((identifier) => JSON.stringify([identifier.type, identifier.namespace ?? "", identifier.normalized]));
  },

  hardConstraints(input, candidate) {
    const inputText = textFor(input);
    const candidateName = candidateText(candidate);
    const inputSize = tireSizeToken({ productName: inputText, brand: input.brand, category: "Tire" });
    const candidateSize = tireSizeToken({ productName: candidateName, brand: candidate.brand, category: "Tire" });
    const inputLoadSpeed = loadSpeedFor(input, inputText);
    const candidateLoadSpeed = loadSpeedFor(candidate, candidateName);
    const contradictions: string[] = [];
    const corroborated: string[] = [];
    const missing: string[] = [];

    if (inputSize && candidateSize) {
      if (inputSize !== candidateSize) contradictions.push(`tire_size_mismatch:${inputSize}!=${candidateSize}`);
      else corroborated.push(`tire_size:${inputSize}`);
    } else {
      missing.push("tire_size");
    }

    const inputTokens = nameTokens(inputText);
    const candidateTokens = nameTokens(candidateName);
    if (plusGenerationDiff(inputTokens, candidateTokens)) contradictions.push("tire_generation_mismatch");

    if (input.brand && candidate.brand) {
      if (sameBrandFamily(input.brand, candidate.brand)) corroborated.push("brand_family");
      else contradictions.push("verified_brand_mismatch");
    } else {
      missing.push("brand");
    }

    if (inputLoadSpeed && candidateLoadSpeed) {
      if (inputLoadSpeed !== candidateLoadSpeed) contradictions.push(`load_speed_mismatch:${inputLoadSpeed}!=${candidateLoadSpeed}`);
      else corroborated.push(`load_speed:${inputLoadSpeed}`);
    } else {
      missing.push("load_speed");
    }

    return constraintResult(contradictions, corroborated, missing);
  },

  semanticFeatures(input, candidate) {
    const score = jaccard(nameTokens(textFor(input)), nameTokens(candidateText(candidate)));
    return { score, orderedFeatureScores: [{ feature: "tire_name_jaccard_review_only", score }], automaticEligible: false };
  },
};
