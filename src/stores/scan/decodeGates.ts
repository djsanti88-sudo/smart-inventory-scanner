import type { AiLookupResult, AiStatus, DecodeDecision } from "@/types";
import { canRequest, isDailyCapReached, type AiGateReason, type BreakerState } from "@/decoding/limits/circuitBreaker";
import { isPlatformOwnerClient } from "@/users-businesses/roles/roleAccess";
import { isTireContext, hasCountableTireIdentity } from "@/decoding/tireSpecs";
import { isUsableProductName } from "@/decoding/decode";
import { shouldAutoApplySuggestion } from "@/stores/scanGates";
import { gradeBarcode } from "@/products/barcodes/barcodeTrust";

/**
 * Decide whether an unknown scan should auto-run the live decode pipeline, and if not, WHY.
 * The "why" becomes the scan-row reason so the user always knows what happened (no silent skip).
 */
function evaluateAutoDecode(p: {
  aiEnabled: boolean;
  status: AiStatus;
  online: boolean;
  dailyCount: number;
  dailyLimit: number;
  breaker: BreakerState;
  now: number;
  /** GOD CLIENT (owner-approved 2026-08-07): the client-side platformOwner UI hint (derived from the
   *  SAME `effectiveClientAccessLevel` allowlist check `useAccessLevel`/`useIsPlatformOwner` use - never
   *  a server-trusted flag). When true, this only stops the CLIENT from pre-blocking the owner's own
   *  scans on the cap/breaker/emergency-stop gates below so a decode attempt always fires; the server
   *  remains the sole security-authoritative gate (isGod re-derived there from a verified token). Every
   *  OTHER client gate (AI off, server live-disabled, auto-decode-on-scan off, offline, missing keys)
   *  still applies unchanged - those are not caps/breaker/emergency, they are real preconditions for a
   *  decode attempt to make sense at all. */
  platformOwner?: boolean;
}): { allowed: boolean; reason: string } {
  if (!p.aiEnabled) return { allowed: false, reason: "AI lookup is off. Turn it on in Settings to auto-decode." };
  if (!p.status.liveEnabled)
    return { allowed: false, reason: "Live AI lookup is disabled on the server (ENABLE_LIVE_AI_LOOKUP=false)." };
  if (!p.status.autoDecodeOnScan) return { allowed: false, reason: "Auto decode on scan is disabled." };
  const isGodClient = p.platformOwner === true;
  if (!isGodClient && p.status.emergencyStop)
    return { allowed: false, reason: "Emergency stop is active. AI calls are paused." };
  if (!p.online) return { allowed: false, reason: "Offline. Saved locally; AI was not called." };
  const freeDecodeAvailable = p.status.freeDecodeAvailable === true;
  // When the server advertises free/local decode rungs (tire corpus, retail corpus, caches), do not
  // client-block solely on paid-provider keys or a spent cap: the server will answer $0 hits before
  // applying paid-decode gates. Older/mocked status payloads omit this flag, so they keep the legacy
  // key/cap client gate and existing tests do not accidentally start real/network decode attempts.
  if (!freeDecodeAvailable && !p.status.openaiConfigured) {
    const missing = p.status.missingKeys.join(", ") || "OPENAI_API_KEY";
    return { allowed: false, reason: `No API keys configured (missing: ${missing}). Set them server-side, then retry live decode.` };
  }
  if (!isGodClient && !freeDecodeAvailable && isDailyCapReached(p.dailyCount, p.dailyLimit))
    return { allowed: false, reason: "Daily AI lookup cap reached. Routed to Needs Review." };
  if (!isGodClient && !canRequest(p.breaker, p.now).allowed)
    return { allowed: false, reason: "AI circuit breaker is open after repeated failures. Routed to Needs Review." };
  return { allowed: true, reason: "Decoding with AI..." };
}

/** GATE-BYPASS hint ONLY (advisory only - see evaluateAutoDecode's `platformOwner` doc). Deliberately
 *  uses `isPlatformOwnerClient` (the raw NEXT_PUBLIC_PLATFORM_OWNER_UIDS/EMAILS allowlist check), NOT
 *  `effectiveClientAccessLevel`/`useAccessLevel`/`useIsPlatformOwner` - those ALSO honor
 *  `NEXT_PUBLIC_E2E_PLATFORM_OWNER=1` (the mock-E2E full-UI-access override used by the 11 mock
 *  Playwright specs), which must grant the platformOwner UI ROLE without ever granting a cap/breaker/
 *  emergency-stop BYPASS to an arbitrary E2E-mocked identity. A dedicated name (not shared with the UI
 *  role hint) keeps that distinction impossible to blur at a future call site. */
function isPlatformOwnerForGateBypass(userId: string | null): boolean {
  return isPlatformOwnerClient({ uid: userId });
}

/**
 * GOD CLIENT (owner-approved 2026-08-07): shared override for every `evaluateAiGate` re-check on a
 * decode-execution path (`runLiveDecodeOnce`, `backgroundVerifyDeep`
 * follow-up). `evaluateAutoDecode` already bypasses the SAME cap/breaker/emergency-stop pre-block at
 * enqueue time; `evaluateAiGate` is a separate, lower-level re-check each of those paths runs again
 * just before actually firing (defense-in-depth against state drifting between enqueue and execution).
 * Owner intent (2026-08-07 review): "god account has no caps, limits, or anything" - so ALL decode
 * paths must never client-pre-block the platform owner, not only the primary scan-time path. Only
 * `daily_cap`/`circuit_open` are overridden here; `disabled` (AI off) and `offline` remain real
 * preconditions for everyone, god included - matching `evaluateAutoDecode`'s own scope exactly.
 */
function applyGodGateOverride<T extends { allowed: boolean; reason: AiGateReason }>(
  gate: T,
  isGodClient: boolean,
): T {
  if (isGodClient && (gate.reason === "daily_cap" || gate.reason === "circuit_open")) {
    return { ...gate, allowed: true };
  }
  return gate;
}

/**
 * Tire portion of the auto-count gate, shared by liveDecode + backgroundVerifyDeep so the spec requirement
 * cannot drift between the two paths again. A non-tire decode is unaffected; a tire must carry the COUNTABLE
 * identity (brand-prefix + size + model), matching the route's verify gate (decode.ts hasCountableTireIdentity).
 * Load index + speed rating are optional enrichment, not required to count. This relaxes ONLY the spec
 * requirement; every other clause of the gate (verified status, app-verified exact code, confidence >= 0.8,
 * firewall / brand-prefix conflict, planAutoVerify) is enforced separately and unchanged.
 */
function tireAutoCountOk(best: AiLookupResult | null | undefined): boolean {
  return !isTireContext(best) || hasCountableTireIdentity(best);
}

/**
 * BUG FIX (badge/reason contradiction, live-proven 115-code preview run): a raw decode `decision.reason`
 * describes the SOURCE's own confidence tier ("Verified from the trusted tire knowledge base (exact
 * barcode). No AI lookup needed.") - that text is only honest on a row actually badged "verified". The
 * feed-row write site downgrades a raw "verified" decision.status to a "suggested" display badge the
 * INSTANT the decode response lands (a raw verified decode still has to clear the app's own auto-count
 * gate / resolveUnknown before it can honestly claim "Verified match" - see the "BUG FIX
 * (verified-shows-Unidentified, burst report)" comment on the same write site). Without this, the row
 * showed decodeStatus "suggested" (or a later "needs_review"/"conflict") while `reason` kept the raw
 * "Verified...No AI lookup needed" claim - a direct contradiction the owner caught live. This function is
 * the SINGLE choke point that reframes a verified-tier reason into an honest suggested-tier one whenever
 * the displayed badge is not (or no longer) "verified". Never invents a new reason - reuses the same text,
 * relabeled, so a corpus/trusted-source hit is still traceable, just described accurately for the tier
 * actually shown. A non-"verified" raw decision's reason is already honest for its own tier and passes
 * through unchanged.
 */
function honestReasonForBadge(rawReason: string | undefined | null, rawStatus: string | undefined, displayedBadge: string | undefined): string {
  const reason = rawReason ?? "";
  if (!reason) return reason;
  if (rawStatus !== "verified" || displayedBadge === "verified") return reason;
  // The source found an exact/strong match, but the app has not (yet, or ever) independently resolved it
  // to a real counted product - state that honestly instead of echoing the source's own "Verified"/"No AI
  // lookup needed" framing over a non-verified badge.
  return `Matched from a trusted source (${reason.replace(/^Verified\s+/i, "").replace(/\.\s*No AI lookup needed\.?$/i, "")}). Needs confirmation before it counts as verified.`;
}

/**
 * Thin store-side wrapper over the pure shouldAutoApplySuggestion gate (src/stores/scanGates.ts): it only
 * computes productNameUsable from the raw productName and delegates. The trust rules live in the pure
 * module; keeping this wrapper preserves the two identical call sites (liveDecode + backgroundVerifyDeep).
 */
function autoSuggestApplyOk(params: {
  autoAddOn: boolean;
  contextConflict: unknown;
  productName: string;
  confidence: number;
  status: string | undefined;
  exactCodeEvidenceVerifiedByApp: boolean;
}): boolean {
  return shouldAutoApplySuggestion({
    autoAddOn: params.autoAddOn,
    contextConflict: params.contextConflict,
    productNameUsable: isUsableProductName(params.productName),
    confidence: params.confidence,
    status: params.status,
    exactCodeEvidenceVerifiedByApp: params.exactCodeEvidenceVerifiedByApp,
  });
}

/** Defense in depth (AM-4.4): a decode-provided barcode field that fails the trust gate is scrubbed
 *  from the review's suggested* fields so no approve path can launder it into identity. */
function scrubSuggestedBarcode(value: string | undefined, partNumber?: string): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return gradeBarcode({ barcode: v, partNumber }).verdict === "rejected" ? "" : v;
}

function trustedExactCanonicalId(data: {
  decision?: DecodeDecision;
  trustedExact?: { path?: unknown; index?: { schemaVersion?: unknown; contentDigest?: unknown } };
}): string | null {
  const decision = data.decision;
  const index = data.trustedExact?.index;
  const id = decision?.trustedExactCanonicalProductId;
  return decision?.status === "verified"
    && decision.exactCodeEvidenceVerifiedByApp === true
    && decision.corroborationPath === "boss_trusted_exact_barcode"
    && data.trustedExact?.path === "boss_trusted_exact_barcode"
    && typeof index?.schemaVersion === "string"
    && /^\d+\.\d+\.\d+$/.test(index.schemaVersion)
    && typeof index.contentDigest === "string"
    && /^[A-F0-9]{64}$/i.test(index.contentDigest)
    && typeof id === "string"
    && /^trusted-exact:v1:[A-F0-9]{32}$/.test(id)
    ? id
    : null;
}

/** PN-BARCODE-CARRY (owner-reported: a PN-resolved suggestion's corpus barcode never carried through
 *  to the counted provisional row). Decides whether a decode's suggested barcode may be carried onto
 *  a provisional product's primaryBarcode. Guard rules:
 *  1. Never clobber a REAL scanned barcode: only carries when the row's current primaryBarcode is
 *     empty, OR equals the scanned cleanCode AND that cleanCode is not itself GTIN-shaped (i.e. it is
 *     a PN/vendor-label placeholder the corpus may upgrade, never a physically-scanned barcode).
 *  2. Must clear the same trust gate as the suggested* fields (scrubSuggestedBarcode /
 *     gradeBarcode) - a bad-check-digit or rejected barcode is never carried.
 *  Returns "" when the carry should NOT happen (caller keeps the existing value). */
function carriedProvisionalBarcode(params: {
  currentPrimaryBarcode: string;
  scannedCleanCode: string;
  scannedCodeType: string;
  candidateBarcode: string | undefined;
  partNumber?: string;
}): string {
  const current = (params.currentPrimaryBarcode ?? "").trim();
  const scannedIsGtin = (["upc_a", "ean_13", "gtin_14"] as string[]).includes(params.scannedCodeType);
  const currentIsPlaceholder = current === "" || (current === params.scannedCleanCode.trim() && !scannedIsGtin);
  if (!currentIsPlaceholder) return ""; // real scanned barcode already present - never clobber
  return scrubSuggestedBarcode(params.candidateBarcode, params.partNumber);
}
export { applyGodGateOverride, autoSuggestApplyOk, carriedProvisionalBarcode, evaluateAutoDecode, honestReasonForBadge, isPlatformOwnerForGateBypass, scrubSuggestedBarcode, tireAutoCountOk, trustedExactCanonicalId };
