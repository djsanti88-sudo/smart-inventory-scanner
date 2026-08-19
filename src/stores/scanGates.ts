/**
 * PURE auto-count gate for decoded scans (Task 2.5 - carved out of scanStore.ts, ZERO behavior change).
 *
 * These functions decide, from plain inputs only, whether a live/deep decode result may be AUTO-COUNTED
 * (written as a verified/aliased identity) or AUTO-APPLIED as a high-trust suggestion onto the counted
 * provisional row. They hold NO store reference, import nothing from the store, and touch no React - the
 * store computes the context-dependent booleans (tireOk, contextConflict) with its own services and passes
 * them in. This keeps the trust rules in one small, directly-testable place that cannot drift between the
 * two decode paths (liveDecode + backgroundVerifyDeep) that both call them.
 *
 * TRUST FIREWALLS baked in here (each was paid for in production pain - do NOT weaken):
 *  - 1225 / T20 lesson: a GPT self-reported "verified" identity may auto-count ONLY on a real public
 *    barcode shape (upc_a / ean_13 / gtin_14). On a vendor/SKU/part-number shape there is no public page
 *    it could have been "found" on, so self-report trust must never count it. See
 *    .superpowers/sdd/task-1225-report.md.
 *  - Wrong identity is FAILURE, Unknown is ACCEPTABLE: every clause is a conjunction; when in doubt the
 *    gate returns not-allowed and the scan stays in Needs Review.
 *  - The provider's self-reported confidence on a "verified" decode is NOT proof; only the app's own
 *    exact-code verification (exactCodeEvidenceVerifiedByApp) or the internet_two_source_size path may
 *    promote a "verified" decode. The confidence>=0.8 shortcut is restricted to non-"verified" decodes.
 *
 * The master switch settings.autoAddDecodedProducts (default true) is applied by the CALLER, not here.
 */

import { isFloorGuessOnlyLabel } from "@/services/catalog/prefixFloorEnrich";
import { parseTireIdentity } from "@/services/catalog/tireListingNormalizer";

/** Public barcode shapes: the only code types a bare provider self-report may ever auto-count on. */
const PUBLIC_BARCODE_SHAPES: readonly string[] = ["upc_a", "ean_13", "gtin_14"];

/** True when the code type is a real public barcode (UPC-A / EAN-13 / GTIN-14). */
export function isPublicBarcodeShape(codeType: string): boolean {
  return PUBLIC_BARCODE_SHAPES.includes(codeType);
}

/**
 * What counts as "corroborated" for auto-count. The app-verified exact code OR the internet_two_source_size
 * path (brand from the strong GS1 prefix + two independent Internet sources agreeing on the size, set
 * app-side by the route race). The local DB is never involved. Every OTHER gate clause is enforced by
 * canAutoCount separately and unchanged.
 */
export function decodeCorroborated(
  decision: { exactCodeEvidenceVerifiedByApp?: boolean; corroborationPath?: string } | null | undefined,
): boolean {
  return (
    Boolean(decision?.exactCodeEvidenceVerifiedByApp) ||
    decision?.corroborationPath === "internet_two_source_size"
  );
}

/** The subset of a DecodeDecision the auto-count gate reads. */
export interface AutoCountDecision {
  status?: string;
  corroborationPath?: string;
  confidence?: number;
  exactCodeEvidenceVerifiedByApp?: boolean;
}

export interface AutoCountInput {
  /** Detected code type (upc_a / ean_13 / gtin_14 / numeric_sku / vendor_label / ...). */
  codeType: string;
  /** The decode decision fields the gate reads. */
  decision: AutoCountDecision | null | undefined;
  /** The decoded product's display name (best?.productName ?? ""). */
  productName: string;
  /** True unless a tire scan lacks its countable identity (store computes via tireAutoCountOk). */
  tireOk: boolean;
  /**
   * Truthy when the decoded identity contradicts the scan context / a learned brand-prefix hint (store
   * computes via detectScanContextConflict). Any truthy value blocks the count.
   */
  contextConflict: unknown;
  /** Whether the product name passes the store's usable-name check (isUsableProductName). */
  productNameUsable: boolean;
}

/**
 * PHASE-7 EVIDENCE GATE (the "evidenceGatePassed" conjunction, verbatim). Auto-count ONLY on the app's
 * independent exact-code verification (or the internet_two_source_size path) at confidence >= 0.8 with a
 * usable name, a countable tire identity (for tires), and NO scan-context conflict - OR the narrower GPT
 * self-report branch which additionally REQUIRES a public barcode shape (1225/T20 firewall).
 *
 * The master switch (autoAddDecodedProducts) and the planAutoVerify status are checked by the caller; this
 * returns only the evidence decision plus a machine reason for logging/rows.
 */
export function canAutoCount(input: AutoCountInput): { allowed: boolean; reason: string } {
  // NOTE: codeType (public-barcode-shape gating) is no longer read here - it was only needed by the
  // now-deleted gptTrusted branch. Kept on AutoCountInput/isPublicBarcodeShape for callers and any
  // future evidence-corroborated-but-shape-gated branch; not destructured to avoid an unused var.
  const { decision, tireOk, contextConflict, productNameUsable } = input;
  const confidence = decision?.confidence ?? 0;
  const status = decision?.status;

  if (!productNameUsable) return { allowed: false, reason: "no usable product name" };
  if (!tireOk) return { allowed: false, reason: "tire scan missing countable identity" };
  if (contextConflict) return { allowed: false, reason: "scan-context / brand-prefix conflict" };
  if (confidence < 0.8) return { allowed: false, reason: "confidence below 0.8 threshold" };

  // Evidence-corroborated branch: app-verified exact code OR internet_two_source_size, on a "verified" decode.
  // D6 core (2026-07-20): this is now the ONLY verified-auto-count path. The former gptTrusted escape
  // hatch (a bare GPT self-report on a public barcode shape) is DELETED - gptResultToDecodePayload no
  // longer emits status "verified" for a self-report, so this branch can never be reached by one
  // anyway; deleting the dead branch here keeps the gate honest and prevents future re-introduction.
  if (status === "verified" && decodeCorroborated(decision)) {
    return { allowed: true, reason: "verified + app-corroborated exact code" };
  }

  return { allowed: false, reason: "verified decode not app-corroborated" };
}

export interface AutoApplySuggestionInput {
  /** Master switch (settings.autoAddDecodedProducts ?? true), passed by the caller. */
  autoAddOn: boolean;
  /** Truthy blocks auto-apply (same firewall as the count gate). */
  contextConflict: unknown;
  /** Whether the product name passes the store's usable-name check (isUsableProductName). */
  productNameUsable: boolean;
  confidence: number;
  status: string | undefined;
  exactCodeEvidenceVerifiedByApp: boolean;
}

/**
 * AUTO-SUGGEST-APPLY gate (owner order 2026-07-10). A decode that did NOT clear the full auto-count gate
 * can still skip Needs Review and have its identity applied onto the counted provisional row AS A
 * SUGGESTION (never verified, no alias) when confidence >= 0.8 on a NON-"verified" decode, OR the decode is
 * app-verified exact (status "verified" + exactCodeEvidenceVerifiedByApp true, the Go-UPC exact class).
 *
 * TRUST FIREWALL (do not remove): the confidence>=0.8 clause is INTENTIONALLY restricted to
 * status !== "verified". A raw confidence on a "verified" decode is the PROVIDER'S self-reported number and
 * is not itself proof - only the app's own evidence check may promote a "verified" decode here. Without
 * this, a bare gpt_self_report "verified" decode on a 4-digit vendor SKU at confidence 0.9 would auto-apply
 * a fabricated identity as a "suggestion" - the exact T20/code-1225 failure class. A wrong identity on the
 * counted row is still wrong; "only a suggestion" is not an exemption.
 */
export function shouldAutoApplySuggestion(input: AutoApplySuggestionInput): boolean {
  return (
    input.autoAddOn &&
    !input.contextConflict &&
    input.productNameUsable &&
    ((input.confidence >= 0.8 && input.status !== "verified") ||
      (input.status === "verified" && input.exactCodeEvidenceVerifiedByApp === true))
  );
}

/**
 * ONE-TAP APPROVE gate for a feed row (best-guess display, owner decision 2026-08-19). A human tap
 * teaches an approved tenant alias, so the name under the button must be a real candidate identity:
 *  - never the prefix-floor NAMING AID ("<Brand> / product unconfirmed") - it names no product (F5);
 *  - never a multi-variant listing ("... 97W / 99H / 101V ...") - it names several products, not one.
 * Both already keep the inline pending path honest; this applies the same line to a row whose
 * identity was auto-applied (>= 0.8) and later surfaced with Approve. Edit/Identify stay available.
 */
export function canOneTapApproveIdentity(name: string | undefined): boolean {
  const n = (name ?? "").trim();
  return n !== "" && !isFloorGuessOnlyLabel(n) && !parseTireIdentity(n).multiVariant;
}
