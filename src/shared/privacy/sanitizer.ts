// Deterministic data sanitizer. Runs BEFORE any untrusted text reaches the AI lookup layer.
// Masks PII and internal cost/pricing so private business data never leaves the app.
// Pure functions, no React, no next/*.

export interface SanitizeResult {
  clean: string;
  maskedCounts: {
    email: number;
    phone: number;
    cost: number;
    money: number;
    name: number;
  };
}

// --- Patterns (intentionally conservative; over-masking is safer than leaking) ---

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Phone: 10-15 digits allowing spaces, dashes, dots, parentheses and an optional +country.
const PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?(?!\d)/g;

// Explicit cost/price/margin markers paired with a number.
// e.g. COST-12.50  COST: 12.50  cost $12.50  internal cost 12.50  wholesale 9  buy price 7.25
const COST_LABELED = /\b(?:internal\s+cost|wholesale(?:\s+price)?|buy\s+price|unit\s+cost|cost|price)\b\s*[:=$-]?\s*\$?\s*\d+(?:[.,]\d{1,2})?/gi;

// Margin expressed as a percentage. e.g. "margin 42 percent", "margin: 42%", "markup 30%"
const MARGIN = /\b(?:margin|markup)\b\s*[:=]?\s*\d+(?:\.\d+)?\s*(?:%|percent)/gi;

// A bare money amount ($xx.xx) that sits near a cost/internal/wholesale/margin/buy keyword.
const MONEY_NEAR_COST = /\$\s?\d+(?:[.,]\d{1,2})?/g;
const COST_CONTEXT = /(cost|internal|wholesale|margin|buy\s*price|markup)/i;

// "Name:" / "Customer:" / "Employee:" / "Contact:" style labels followed by a value.
const LABELED_NAME = /\b(?:customer|employee|client|contact|sold\s+to|cashier|rep)\s*(?:name)?\s*[:=]\s*[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}/gi;

/**
 * Sanitize a free-text string for AI lookup. Returns the masked text plus counts of what
 * was masked (useful for logging/proof). Order matters: email and phone first, then labeled
 * cost/margin, then money-near-cost, then labeled names.
 */
export function sanitizeForAiLookup(input: string): SanitizeResult {
  const counts = { email: 0, phone: 0, cost: 0, money: 0, name: 0 };
  let text = input ?? "";

  text = text.replace(EMAIL, () => {
    counts.email++;
    return "[redacted-email]";
  });

  text = text.replace(COST_LABELED, () => {
    counts.cost++;
    return "[redacted-cost]";
  });

  text = text.replace(MARGIN, () => {
    counts.cost++;
    return "[redacted-margin]";
  });

  text = text.replace(LABELED_NAME, () => {
    counts.name++;
    return "[redacted-name]";
  });

  text = text.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "");
    // Too few digits to be a phone -> almost certainly digits embedded in a SKU (e.g. T432119).
    if (digits.length < 10) return m;
    // A continuous 11-14 digit run with no separators is a UPC/EAN/GTIN, not a phone number.
    if (/^\d+$/.test(m.trim()) && digits.length >= 11 && digits.length <= 14) return m;
    counts.phone++;
    return "[redacted-phone]";
  });

  // Mask remaining bare money amounts only when a cost-ish keyword is present in the text.
  if (COST_CONTEXT.test(text)) {
    text = text.replace(MONEY_NEAR_COST, () => {
      counts.money++;
      return "[redacted-amount]";
    });
  }

  return { clean: text, maskedCounts: counts };
}

/** Convenience: true if anything sensitive was found. */
export function containsSensitiveData(input: string): boolean {
  const r = sanitizeForAiLookup(input);
  const c = r.maskedCounts;
  return c.email + c.phone + c.cost + c.money + c.name > 0;
}
