// Human-mistake warning guard. PURE (no React/next/network). Prevents accidental wrong links such as
// attaching a Falken tire part number to "Camel Crush Menthol Silver Cigarettes." It compares what the
// scanned code LOOKS like (from an AI/web suggestion and/or the code's own shape) against the product a
// human is linking it to, and returns a risk verdict + a human-readable warning. It NEVER silently
// blocks or auto-links; the caller decides (owner may override with explicit confirmation + audit).

export type MismatchRisk = "safe" | "warn" | "high_risk";

export interface MismatchIdentity {
  name?: string;
  brand?: string;
  category?: string;
}

export interface MismatchInput {
  scannedCode: string;
  /** What the code looks like per AI/web lookup (if any was run). */
  suggested?: MismatchIdentity;
  /** The product the human selected to link the code to. */
  target: MismatchIdentity;
}

export interface MismatchVerdict {
  risk: MismatchRisk;
  reason: string;
  message: string; // human-facing
  suggestedDomain: string | null;
  targetDomain: string | null;
  suggestedName?: string;
}

// Coarse product domains + the keywords that signal them. Cross-domain links are almost always mistakes.
const DOMAIN_KEYWORDS: Record<string, RegExp> = {
  tire: /\b(tire|tyre|all[-\s]?season|all[-\s]?terrain|\d{3}\/\d{2}\s?z?r\d{2})\b|\b(falken|michelin|goodyear|bridgestone|firestone|continental|pirelli|toyo|nitto|nexen|hankook|kumho|cooper|bfgoodrich|yokohama|dunlop|sailun)\b/i,
  tobacco: /\b(cigarette|cigarettes|cigar|tobacco|menthol|nicotine|vape|e-?cig|camel|marlboro|newport|winston)\b/i,
  beverage: /\b(soda|cola|coca[-\s]?cola|pepsi|drink|beverage|juice|water|beer|wine|energy drink)\b/i,
  food: /\b(food|snack|candy|chocolate|chips|cookie|cereal|grocery|sauce)\b/i,
  supplement: /\b(protein|whey|vitamin|supplement|creatine|collagen)\b/i,
  battery: /\b(battery|batteries|lithium|alkaline|aa|aaa)\b/i,
  auto_part: /\b(brake|rotor|spark plug|oil filter|air filter|wiper|alternator|radiator|muffler|auto part)\b/i,
  tool: /\b(drill|driver|impact|wrench|saw|tool|grinder|sander)\b/i,
};

/** Infer a coarse product domain from free text (name + brand + category). null when unknown. */
export function inferDomain(identity: MismatchIdentity | undefined): string | null {
  if (!identity) return null;
  const text = [identity.name, identity.brand, identity.category].filter(Boolean).join(" ");
  if (!text.trim()) return null;
  for (const [domain, re] of Object.entries(DOMAIN_KEYWORDS)) {
    if (re.test(text)) return domain;
  }
  return null;
}

function norm(s?: string): string {
  return (s ?? "").trim().toLowerCase();
}

export function evaluateMismatch(input: MismatchInput): MismatchVerdict {
  const suggestedDomain = inferDomain(input.suggested);
  const targetDomain = inferDomain(input.target);
  const suggestedName = input.suggested?.name?.trim() || undefined;

  // 1. Severe: the code clearly belongs to a different product domain than the target.
  if (suggestedDomain && targetDomain && suggestedDomain !== targetDomain) {
    const sName = suggestedName ? `a ${suggestedName}` : `a ${suggestedDomain} product`;
    return {
      risk: "high_risk",
      reason: "domain_mismatch",
      suggestedDomain,
      targetDomain,
      suggestedName,
      message: `This code looks like ${sName} (${suggestedDomain}), but you are linking it to "${input.target.name ?? "this product"}" (${targetDomain}). I do not think this is the right product. Continue only if you are sure.`,
    };
  }

  // 2. Same/unknown domain but the suggested BRAND clearly differs from the target brand.
  const sb = norm(input.suggested?.brand);
  const tb = norm(input.target.brand);
  if (sb && tb && sb !== tb && !sb.includes(tb) && !tb.includes(sb)) {
    return {
      risk: "warn",
      reason: "brand_mismatch",
      suggestedDomain,
      targetDomain,
      suggestedName,
      message: `This code looks like a "${input.suggested?.brand}" product${suggestedName ? ` (${suggestedName})` : ""}, but you are linking it to a "${input.target.brand}" product. Double-check this is correct.`,
    };
  }

  // 3. No conflicting evidence -> safe (shared brand/category/domain, or no suggestion to compare).
  return { risk: "safe", reason: "no_conflict", message: "", suggestedDomain, targetDomain, suggestedName };
}
