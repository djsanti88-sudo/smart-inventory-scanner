import type { AiLookupResult } from "@/types";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import { detectCodeType } from "@/products/match/codeTypeDetector";
import { killSwitchOn, checkRateLimit, readDailyUsed, intEnv, getGptDecodeStatus } from "@/decoding/limits/aiSpendGuard";
import { GPT_DECODE_WORST_CASE_USD, type GptDecodeResult } from "@/decoding/gptDecodeClient";
import { decodeStorage } from "@/server/decode/storage";
// The route owns HTTP/auth/rate-limit concerns. The server pipeline owns deterministic resolution,
// cache replay, the lazy paid authorization, and the single GPT-5.4 mini provider call.
import { runDecodePipeline, e2eMode } from "@/server/decode/pipeline";
import { clampDecodeBudgetMs } from "@/decoding/decodeBudget";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import { isLiveAuth } from "@/authentication/service/authMode";
import { clampConfidenceThreshold } from "@/decoding/limits/decodePolicy";
import { buildMasterCatalogEntry, appendMasterCatalogEntry } from "@/server/catalog/masterAppend";
import { logServerEvent } from "@/server/log";
import { cleanScanCode } from "@/scanning/clean/scanCleaner";
import { resolveTrustedExactBarcodeDecision } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { getTireExactIndexFingerprint, hasBossHmacKeyConfigured } from "@/server/tire-knowledge/tireExactIndex";
import { trustedExactRateLimiter } from "@/decoding/limits/trustedExactRateLimit";
import { isPlatformOwnerServer } from "@/users-businesses/roles/roleAccess";
import { isDecodeChargeMode, type AiLookupRequestMode } from "./decodeMode";

// Server-side AI endpoint. Keys live in env and never reach the client. ONE mode:
//   - "decode" (alias "decode-deep"): delegates to runDecodePipeline (the APP independently verifies
//     the exact code in each rung's evidence and returns a DecodeDecision; the model's own
//     exactCodeEvidence claim is NOT used to decide truth).
//
// CONSOLIDATION A1 (2026-08-19): the legacy single-provider "lookup" mode is DELETED. It charged two
// daily-cap slots before doing any work, it was the last independent paid correction call in the product
// is permanently out of decode), and it had no UI caller. Any other `mode` value, including a missing
// one, is now an explicit 400 instead of a silent, billable fall-through.
//
// TEST SAFETY: when IS_E2E=1 (set by the Playwright webServer) real providers are NEVER called - so
// automated runs cannot burn live tokens.

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // Admin SDK requires the Node runtime (same as resolve-scan/route.ts:25)

// Fix-wave 2026-08-04: `path` used to be hardcoded to "trusted_exact_miss" for every honest-miss
// body, which meant a not-checked, blocked, or index-unavailable outcome all reported the same path
// as a real checked-and-missed lookup. The sole client consumer (scanStore.ts trustedExactCanonicalId)
// only ever compares trustedExact.path against the success value "boss_trusted_exact_barcode", so
// widening the honest-miss path values here is purely additive observability - it changes no client
// behavior.
function deterministicMissBody(
  reasonCode = "trusted_exact_miss",
  reason = "No trusted exact match was found.",
  path = "trusted_exact_miss",
) {
  return {
    mode: "decode" as const,
    providerNames: [] as string[],
    results: [] as AiLookupResult[],
    decision: {
      status: "needs_review" as const,
      confidence: 0,
      reason,
      evidenceStrength: "none" as const,
      exactCodeEvidenceVerifiedByApp: false,
      crossCheck: {
        decision: "not_checked" as const,
        confidence: 0,
        reason,
        brandSimilarity: 0,
        nameSimilarity: 0,
        contradictions: [] as string[],
      },
    },
    reasonCode,
    reasonText: reason,
    timedOut: false,
    trustedExact: { path },
  };
}

// P5b Task 2 (master-truth write hook, GC7/GC8): shared helper fired ONLY on a FRESH compute
// (`kind:"computed"`) that carries a settled DecodeDecision passing the Task-1 trust gate. FIX 4
// (review MEDIUM): a PERSISTED/L2-replay hit (`kind:"persisted"`) NEVER fires this hook - a cached
// payload may have been written under a looser historical verify gate, so replaying it to master
// would be both a trust hole and a per-request transaction storm; pre-P5b cache rows are exactly the
// untrusted class this excludes. Also NEVER fired on `kind:"cap_blocked"` (no decision was ever
// settled). Fire-and-forget: never awaited into the HTTP response, never lets a rejection escape
// (masterAppend.ts already swallows its own errors into "error"; this helper also wraps its entire
// body in try/catch as a second, cheap safety net against a synchronous throw - GC7/review MEDIUM).
// Skipped under e2eMode()/IS_E2E (GC7) and behind a default-ON feature flag so a single env var can
// kill the whole write path without a deploy.
function maybeAppendMasterCatalogEntry(payloadLike: {
  sanitizedInput?: { cleanCodeSanitized?: string; rawCodeSanitized?: string };
  decision?: { status?: string; exactCodeEvidenceVerifiedByApp?: boolean; confidence?: number };
  results?: Array<{ productName?: string; brand?: string; category?: string }>;
}, fallbackCode: string, codeType: string): void {
  // FIX 3 (review MEDIUM, sync-throw): the ENTIRE body runs inside try/catch, not just the async
  // appendMasterCatalogEntry().catch() tail - a synchronous throw in buildMasterCatalogEntry (a plain
  // function call, never awaited) would otherwise propagate straight into the POST handler and break
  // the HTTP response for what is meant to be a fire-and-forget side effect.
  try {
    if (e2eMode()) return;
    if (process.env.MASTER_CATALOG_APPEND === "0") return;
    const decision = payloadLike.decision;
    if (!decision) return;
    const normalizedBarcode = payloadLike.sanitizedInput?.cleanCodeSanitized || fallbackCode;
    const winningResult = payloadLike.results?.[0];
    const entry = buildMasterCatalogEntry({
      normalizedBarcode,
      codeType,
      decision: {
        status: decision.status ?? "",
        exactCodeEvidenceVerifiedByApp: decision.exactCodeEvidenceVerifiedByApp,
        confidence: decision.confidence,
      },
      identity: {
        name: winningResult?.productName,
        brand: winningResult?.brand,
        category: winningResult?.category,
      },
    });
    if (!entry) return;
    void appendMasterCatalogEntry(entry).catch(() => {
      /* GC7: an append failure must never affect the decode response */
    });
  } catch {
    // Never let a synchronous failure in this fire-and-forget side effect break the decode response.
    console.error("maybeAppendMasterCatalogEntry: synchronous failure swallowed");
  }
}

// GET reports which keys/flags are configured. NO secrets are returned (booleans + names only),
// so the client can decide whether to auto-decode and show exactly which keys are missing.
export async function GET(request: Request) {
  // Lightweight per-IP rate limit so the public status endpoint cannot be scraped or flooded unthrottled.
  // It returns only booleans + model names (no secrets), but an unbounded GET is still a cheap DoS / config-
  // scrape vector. Generous default for legit client polling; SEPARATE bucket from POST (GET: prefix) so the
  // two never interfere. Skipped under E2E mock mode, matching the POST guards.
  if (!e2eMode()) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "local";
    // B1: durable, storage-backed rate limiting (DecodeStorage - Turso in production, so a
    // multi-instance deployment shares one real counter instead of each instance's own in-memory bucket).
    //
    // FINDING C (P6 fix wave): wrapped fail-open so a storage INIT throw (`await decodeStorage()` itself
    // rejecting) never turns the status endpoint into a raw 500 - it logs rate_limit_unavailable and falls
    // through unthrottled, matching the export route's pattern and the POST handler below.
    try {
      const rl = await checkRateLimit(`GET:${ip}`, { limit: intEnv(process.env.AI_LOOKUP_GET_RATE_LIMIT, 120), storage: await decodeStorage() });
      if (!rl.allowed) {
        logServerEvent({ route: "/api/ai-lookup", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
        return Response.json(
          { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
        );
      }
    } catch {
      logServerEvent({ route: "/api/ai-lookup", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
    }
  }
  const openaiConfigured = !!process.env.OPENAI_API_KEY;
  const missingKeys: string[] = [];
  if (!openaiConfigured) missingKeys.push("OPENAI_API_KEY");
  // Read-only GPT spend/call status. This makes no provider calls and performs no counter writes.
  const gptDecodeStatus = await getGptDecodeStatus({ worstCaseUsd: GPT_DECODE_WORST_CASE_USD, storage: await decodeStorage() });
  // Task 1 (v2 daily cap): read-only peek at today's atomic, storage-backed usage - makes NO writes
  // (readDailyUsed never increments), so this GET never inflates the counter it is reporting on.
  const dailyLimit = intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000);
  const dailyUsed = await readDailyUsed(await decodeStorage());
  // Spec 2 (M1, kill-switch visibility): the POST handler already 503s every request when the SERVER
  // kill switch is on (line ~234 below); this GET status endpoint must say so too, or Settings looks
  // healthy (missingKeys empty, liveEnabled true) while every scan silently fails to decode.
  const killSwitch = killSwitchOn();
  return Response.json({
    liveEnabled: process.env.ENABLE_LIVE_AI_LOOKUP !== "false",
    autoDecodeOnScan: process.env.ENABLE_AUTO_DECODE_ON_SCAN !== "false",
    openaiConfigured,
    freeDecodeAvailable: true,
    dailyLimit: dailyLimit,
    missingKeys,
    e2e: e2eMode(),
    gptDecode: {
      spentTodayUsd: gptDecodeStatus.spentUsd,
      capUsd: gptDecodeStatus.capUsd,
      callsToday: gptDecodeStatus.calls,
      enabled: openaiConfigured && gptDecodeStatus.allowed,
    },
    // Task 1 (v2 daily cap): exposes the SAME atomic, storage-backed counter the route gates and
    // the paid-decode charge site uses - a read-only peek, never incremented by this GET.
    daily: { used: dailyUsed, limit: dailyLimit },
    decodePath: ["tire_corpus", "retail_corpus", "learned_products", "master_catalog", "persisted_cache", "memory_cache", "gpt_5_4_mini"],
    // Spec 2 (M1): SERVER-side emergency stop (AI_LOOKUP_KILL_SWITCH env var). Distinct from the
    // client-side `emergencyStop` preference in aiStatus - this one the shop owner cannot toggle
    // themselves, so Settings must show it as a separate, clearly-labeled condition.
    killSwitchOn: killSwitch,
  });
}

export async function POST(request: Request) {
  let body: {
    rawCode?: string;
    cleanCode?: string;
    codeType?: string;
    mode?: AiLookupRequestMode | string;
    confidenceThreshold?: number;
    budgetMs?: number;
    scanContext?: "any" | "tire"; // Phase 8B: app-derived, non-authoritative prompt hint
    autoCountNonPublicWithEvidence?: boolean; // Option 3 (owner): allow a non-public code (SKU/vendor/FNSKU) to auto-verify from a single trusted source. Default true.
    // Playwright test hook ONLY: under IS_E2E, a request carrying this fixture runs the GPT decode
    // rung's mapping logic with ZERO network so E2E can prove the rung's UI/decision wiring
    // deterministically. Ignored entirely outside E2E.
    mockGptDecode?: Partial<GptDecodeResult>;
    // Task 4 (owner manual override): skips the L1/L2 cache peeks AND overwrites the stored row once the
    // fresh compute finishes. Also forces a fresh compute past the in-memory L1 cache (forceRefresh).
    forceRetry?: boolean;
    // D4 (live-mode auth): the caller's Firebase ID token + the businessId they claim membership in.
    // Ignored entirely in mock mode (today's open-demo behavior is unchanged).
    idToken?: string;
    businessId?: string;
    /** Work-reduction only. The server still derives trusted-corpus access from auth + membership + allowlist. */
    deterministicOnly?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // CONSOLIDATION A1: the decode pipeline is the ONLY path this endpoint serves. Reject anything else
  // here - before auth, before any counter read, before any storage touch - so an unrecognised (or
  // omitted) mode can never fall through into billable work. Every production client and every proof
  // script already sends mode "decode" or "decode-deep".
  if (!isDecodeChargeMode(body.mode)) {
    return Response.json(
      { error: 'Unsupported mode. Use mode:"decode".', reasonCode: "unsupported_mode" },
      { status: 400 },
    );
  }

  // LIVE-MODE AUTH (D4). In mock mode this whole block is skipped, so the open-demo behavior and every
  // existing test are unchanged. In live mode the caller must present a verified Firebase ID token and a
  // businessId they are a member of - identical pattern to resolve-scan/route.ts. ORDERING CONTRACT
  // (locked by route.d4.test.ts): this gate completes BEFORE any quota read or charge, global or
  // per-account - a 401/403 request must never touch a counter key.
  let authedBusinessId: string | null = null;
  let authedUid: string | null = null;
  // GOD ACCOUNT (owner order 2026-08-07): the platform owner bypasses every server spend/rate/cap gate
  // (but NOT the kill switch). Derived ONLY from the freshly verified token + the SERVER-ONLY
  // PLATFORM_OWNER_UIDS/EMAILS allowlist (isPlatformOwnerServer) - never NEXT_PUBLIC_*, never a request
  // header/body flag, so a customer cannot forge it. Stays false in mock/E2E (no verifiable token).
  let isGod = false;
  if (isLiveAuth() && !e2eMode()) {
    const idToken = (body as { idToken?: string }).idToken ?? "";
    const bizId = (body as { businessId?: string }).businessId ?? "";
    if (!idToken.trim()) {
      return Response.json({ error: "Sign in required.", reasonCode: "unauthenticated" }, { status: 401 });
    }
    if (!bizId.trim()) {
      return Response.json({ error: "Missing businessId.", reasonCode: "no_business" }, { status: 400 });
    }
    let uid = "";
    let email: string | null = null;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
      // GOD ACCOUNT security (2026-08-07): the god email arm must NEVER fire on an UNVERIFIED email
      // claim - anyone presenting a project-valid token whose email == the owner's string with
      // email_verified:false would otherwise become god. Trust the email ONLY when Firebase says it is
      // verified; otherwise leave it null (the UID arm still lights up god for the real owner, whose
      // uid is in PLATFORM_OWNER_UIDS). `email` is used exclusively for the isGod computation below.
      email = decoded.email_verified ? (decoded.email ?? null) : null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(msg)) {
        return Response.json({ error: "Server auth is not configured.", reasonCode: "auth_unavailable" }, { status: 503 });
      }
      return Response.json({ error: "Invalid or expired sign-in.", reasonCode: "bad_token" }, { status: 401 });
    }
    // Private trusted-exact corpus access must reflect revocation immediately. There is no
    // authoritative revocation signal for this process-local cache, so every request reads the
    // membership document after verifying its token.
    const member = await getAdminDb().doc(`${COLLECTIONS.businessMembers}/${memberDocId(bizId, uid)}`).get();
    if (!member.exists) {
      return Response.json({ error: "Not a member of this business.", reasonCode: "not_member" }, { status: 403 });
    }
    authedBusinessId = bizId;
    authedUid = uid;
    // Server-verified, un-spoofable: reads the NON-PUBLIC allowlist over the cryptographically verified
    // token identity. An allowlisted UID OR email lights this up. Threaded into every gate below.
    isGod = isPlatformOwnerServer({ uid: authedUid, email });
    // S1 (deep review 2026-08-09): the verify above deliberately does NOT pass checkRevoked - this is
    // the bulk-scan hot path and one extra Admin round-trip per scan is real latency for every user.
    // But a token that would grant GOD bypasses every spend/rate/cap gate, so a stolen owner token
    // surviving session revocation is a direct bill-drain hole. Re-verify with checkRevoked=true ONLY
    // on the god arm: rare (owner-only), cheap, and it closes the cap-bypass. A revoked token 401s
    // rather than silently degrading to normal-user treatment - we now have POSITIVE knowledge that
    // this credential was deliberately killed, and honoring it at all would be knowingly serving a
    // revoked session; the honest answer to the caller is "sign in again", not a quiet downgrade.
    if (isGod) {
      try {
        await getAdminAuth().verifyIdToken(idToken, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(msg)) {
          return Response.json({ error: "Server auth is not configured.", reasonCode: "auth_unavailable" }, { status: 503 });
        }
        logServerEvent({
          route: "/api/ai-lookup",
          event: "auth_rejected",
          reasonCode: "token_revoked",
          businessId: bizId,
          status: 401,
        });
        return Response.json(
          { error: "This sign-in was revoked. Sign in again.", reasonCode: "token_revoked" },
          { status: 401 }
        );
      }
    }
  }

  // Keep the exact scanned identifier local to the trusted index. The AI sanitizer intentionally masks
  // 10-digit phone-shaped strings, but approved shop identifiers can legitimately have that shape.
  // A bare 8-14 digit scan code passes through unmasked to the decode pipeline; all other text stays
  // sanitized.
  const exactCode = cleanScanCode(body.cleanCode ?? body.rawCode ?? "").cleanCode;
  // Defense in depth: sanitize again on the server before anything reaches a provider.
  const rawCodeSanitized = sanitizeForAiLookup(body.rawCode ?? "").clean;
  const cleanCodeSanitized = sanitizeForAiLookup(body.cleanCode ?? "").clean;
  // A scanned identifier that is one bare digit run of 8 to 14 digits is a lookup code, not free
  // text. The phone sanitizer masks bare 10-digit runs, which made every downstream rung search
  // for the literal string "[redacted-phone]" instead of the real code. Formatted phone numbers
  // (separators, letters, extra words) never match this shape and stay masked.
  const bareNumericCode = /^\d{8,14}$/.test(exactCode) ? exactCode : null;
  const code = bareNumericCode ?? (cleanCodeSanitized || rawCodeSanitized);
  // D4: never trust the client's codeType. Always recompute from the sanitized code server-side.
  const codeType = detectCodeType(code);
  // D4 (full surface): scanContext and autoCountNonPublicWithEvidence are DECISION inputs, not hints.
  // scanContext === "tire" unlocks three extra auto-verify paths in decideDecode (decode.ts:285/304/323)
  // and allowNonPublicAutoCount unlocks nonPublicTrustedVerified (decode.ts:269) - the decode-1225
  // hallucinated-auto-count class. LIVE mode: server policy decides, the client's values are ignored
  // (AI_LIVE_SCAN_CONTEXT=tire opts a deployment into the tire context; default "any" unlocks nothing;
  // AI_ALLOW_NONPUBLIC_AUTOCOUNT=1 opts into non-public auto-count; default off). MOCK mode: the client
  // hint is honored exactly as today (validated to the known set), so the demo substrate is unchanged.
  const SCAN_CONTEXTS = new Set(["any", "tire"]);
  const clientScanContext =
    typeof body.scanContext === "string" && SCAN_CONTEXTS.has(body.scanContext)
      ? (body.scanContext as "any" | "tire")
      : undefined;
  const scanContext: "any" | "tire" | undefined =
    isLiveAuth() && !e2eMode()
      ? (process.env.AI_LIVE_SCAN_CONTEXT === "tire" ? "tire" : "any")
      : clientScanContext;
  const allowNonPublicAutoCount =
    isLiveAuth() && !e2eMode()
      ? process.env.AI_ALLOW_NONPUBLIC_AUTOCOUNT === "1"
      : body.autoCountNonPublicWithEvidence !== false;
  const forceRetry = body.forceRetry === true;

  // BOSS FOR EVERYONE (owner order 2026-08-07, Option A full): the boss/supplier corpus is main-database
  // product identity meant for EVERY authenticated account, so access is now any verified member
  // (authedUid + authedBusinessId present) - the TRUSTED_EXACT_BOSS_BUSINESS_IDS allowlist no longer
  // gates it. The request boolean still can only reduce work; it never grants access. Every integrity
  // gate is preserved downstream (HMAC manifest + per-shard SHA-256 in resolveTrustedExactBarcodeDecision,
  // the package-code block, and the public-barcode-shape auto-count gate in decideDecode). The uid+business
  // scanner limiter still runs before both hits and misses - EXCEPT for the god account, which bypasses it.
  const trustedBossAccess = Boolean(authedUid && authedBusinessId);
  if (trustedBossAccess && authedUid && authedBusinessId) {
    if (!isGod) {
      const exactRate = trustedExactRateLimiter.check(authedUid, authedBusinessId);
      if (!exactRate.allowed) {
        return Response.json(
          { error: "Too many trusted exact lookups. Slow down and try again.", reasonCode: "trusted_exact_rate_limited" },
          { status: 429, headers: { "Retry-After": String(Math.ceil(exactRate.retryAfterMs / 1000)) } },
        );
      }
    }
    const exact = await resolveTrustedExactBarcodeDecision(exactCode, { authenticatedBossCorpus: true });
    if (exact.kind === "hit") {
      const index = await getTireExactIndexFingerprint();
      const canonicalId = exact.result.decision.trustedExactCanonicalProductId;
      if (!index || (exact.sourceScope === "authenticated_boss_corpus" && !canonicalId)) {
        // L16 (probes never dead-end): the shard returned a hit but its integrity fingerprint cannot be
        // verified, so the hit is untrustworthy. The deterministicOnly probe reports the honest
        // unavailable signal; the full decode path continues rather than dead-ending
        // this (and, under Option A, every) code to Needs Review on an index-integrity gap.
        if (body.deterministicOnly === true) {
          return Response.json(deterministicMissBody("exact_index_unavailable", "Trusted exact index verification is unavailable.", "trusted_exact_unavailable"));
        }
        // else: fall through to the full decode path (skip returning the unverifiable hit).
      } else {
      const result = exact.result.results[0];
      return Response.json({
        mode: "decode",
        providerNames: ["tire-corpus"],
        results: [{
          productName: result.productName,
          brand: result.brand,
          category: result.category,
          specsShort: result.specsShort,
          primarySku: result.primarySku,
          primaryBarcode: result.primaryBarcode,
          gtin: result.gtin,
          upc: result.upc,
          ean: result.ean,
          confidence: result.confidence,
        }],
        decision: {
          status: "verified",
          confidence: exact.result.decision.confidence,
          reason: exact.result.decision.reason,
          evidenceStrength: "fetched_source",
          exactCodeEvidenceVerifiedByApp: true,
          corroborationPath: exact.result.decision.corroborationPath,
          ...(canonicalId ? { trustedExactCanonicalProductId: canonicalId } : {}),
          crossCheck: {
            decision: "single_provider",
            confidence: exact.result.decision.confidence,
            reason: exact.result.decision.reason,
            brandSimilarity: 1,
            nameSimilarity: 1,
            contradictions: [],
          },
        },
        reasonCode: "trusted_exact_hit",
        reasonText: exact.result.decision.reason,
        timedOut: false,
        trustedExact: {
          path: exact.sourceScope === "authenticated_boss_corpus" ? "boss_trusted_exact_barcode" : "trusted_exact_barcode",
          index,
        },
      });
      }
    }
    if (exact.kind === "blocked_package") {
      return Response.json(deterministicMissBody("blocked_package", "This package barcode requires review.", "trusted_exact_blocked_package"));
    }
    if (exact.kind === "unavailable") {
      // Defect #42 (2026-08-06): this outcome was previously silent server-side, letting the deployed
      // environment missing BOSS_EXACT_INDEX_HMAC_KEY entirely masquerade as an unremarkable per-scan
      // miss for every allowlisted business. Log which unavailability class fired so Vercel function
      // logs distinguish a missing key (config gap) from a corrupt/unreadable manifest or shard
      // (asset-integrity gap) - no code, identity, or key value is ever included.
      logServerEvent({
        route: "/api/ai-lookup",
        event: "trusted_exact_index_unavailable",
        reasonCode: "exact_index_unavailable",
        businessId: authedBusinessId ?? undefined,
        status: 200,
        detail: hasBossHmacKeyConfigured() ? "shard_or_manifest_invalid" : "missing_hmac_key",
      });
      // L16 (owner rule 2026-08-05, "probes never dead-end") + Option A: every authed user now hits this
      // trusted path, so a missing/rotated HMAC key or a failed shard SHA must NOT short-circuit EVERY
      // customer's decode to Needs Review. The deterministicOnly PROBE still returns its honest
      // unavailable signal (so the client knows the index could not be consulted); the FULL decode path
      // Falls through to the ordinary free-first decode path so codes can still resolve.
      if (body.deterministicOnly === true) {
        return Response.json(deterministicMissBody("exact_index_unavailable", "Trusted exact lookup requires review.", "trusted_exact_unavailable"));
      }
      // else: do not return - continue to the full decode path below.
    }
  }

  // Deterministic-only is a work-reduction request. A non-allowlisted member, a mock caller, or an
  // allowlisted exact miss exits here without reaching storage, catalog, legacy, or provider code.
  if (body.deterministicOnly === true) {
    if (!trustedBossAccess) {
      return Response.json(
        deterministicMissBody(
          "trusted_exact_not_available",
          "Trusted exact lookup is not enabled for this session, so the code was not checked against the trusted index.",
          "trusted_exact_not_checked",
        ),
      );
    }
    return Response.json(deterministicMissBody("trusted_exact_miss"));
  }

  // Legacy abuse/spend controls intentionally begin only after the free authenticated exact path.
  if (!e2eMode()) {
    if (killSwitchOn()) {
      logServerEvent({ route: "/api/ai-lookup", event: "kill_switch", reasonCode: "kill_switch", status: 503 });
      return Response.json({ error: "AI lookup is temporarily disabled.", reasonCode: "kill_switch" }, { status: 503 });
    }
    // GOD ACCOUNT bypasses the per-IP rate limit (the kill switch above is NOT bypassed - it stays
    // enforced for everyone, god included, because it is the owner's own emergency stop).
    if (!isGod) {
      const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
      try {
        // Route-family key prefix (matches this file's own GET handler's "GET:${ip}" and the export
        // route's "EXPORT:${ip}" convention): without it this POST handler shared a raw-IP bucket
        // with every OTHER route calling checkRateLimit(ip, ...) (catalog-dispute, catalog-review,
        // catalog-review/[id]), so a bulk-scan session hammering ai-lookup could exhaust an
        // unrelated catalog route's limit for the same client IP, and vice versa, even though each
        // route configures its own distinct rate-limit env var.
        const rl = await checkRateLimit(`POST:${clientIp}`, { storage: await decodeStorage() });
        if (!rl.allowed) {
          logServerEvent({ route: "/api/ai-lookup", event: "rate_limited", reasonCode: "rate_limited", status: 429 });
          return Response.json(
            { error: "Too many requests. Slow down and try again.", reasonCode: "rate_limited" },
            { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
          );
        }
      } catch {
        logServerEvent({ route: "/api/ai-lookup", event: "rate_limit_unavailable", reasonCode: "storage_error", status: 200 });
      }
    }
  }

  const threshold = clampConfidenceThreshold(body.confidenceThreshold);

  // Account and global paid caps are deliberately enforced inside the pipeline at the exact paid
  // egress boundary. Keeping the route free of a pre-cap preserves all zero-cost corpus/cache hits.
  const accountLimit = intEnv(
    process.env.AI_LOOKUP_ACCOUNT_DAILY_LIMIT,
    intEnv(process.env.AI_LOOKUP_DAILY_LIMIT, 2000),
  );

  const outcome = await runDecodePipeline({
    code,
    codeType,
    rawCodeSanitized: bareNumericCode ?? rawCodeSanitized,
    cleanCodeSanitized: bareNumericCode ?? cleanCodeSanitized,
    threshold,
    allowNonPublicAutoCount,
    forceRetry,
    scanContext,
    mockGptDecode: body.mockGptDecode,
    // Server-side clamp (review hardening 2026-07-15): the client already clamps, but a hand-crafted
    // request must not be able to stretch the decode deadline via a huge budgetMs.
    budgetMs: typeof body.budgetMs === "number" ? clampDecodeBudgetMs(body.budgetMs) : undefined,
    capContext: authedBusinessId
      ? { authedBusinessId, accountLimit }
      : undefined,
    // Server-verified only. This bypasses blocking caps but never the usage/spend accounting writes.
    god: isGod,
  });
  if (outcome.kind === "persisted") {
    // FIX 4 (review MEDIUM, stale-verified replay + transaction storm): NEVER appends here. A cached/
    // L2-replay payload may have been written under a LOOSER historical verify gate than the current
    // one - replaying it to the master catalog on every cache hit is a trust hole (an old, weaker
    // "verified" gets minted into master truth today) and a per-request transaction storm (every
    // repeat scan of a cached code would re-run the idempotent-but-not-free transactional upsert).
    // Only the fresh `computed` branch below appends - a fresh compute is exactly the point where the
    // CURRENT verify gate was applied, so it is the only outcome kind trusted to write master.
    return Response.json(outcome.body);
  }
  if (outcome.kind === "cap_blocked") {
    logServerEvent({
      route: "/api/ai-lookup",
      event: "paid_cap_exhausted",
      reasonCode: outcome.reasonCode,
      businessId: authedBusinessId ?? undefined,
      status: 429,
    });
    return Response.json({ error: outcome.message, reasonCode: outcome.reasonCode, floor: outcome.floor }, { status: 429 });
  }
  // computed: echo the L1/L2 `cached` flag into debug exactly as before. FINDING B (P6 fix wave): the
  // per-account charge USED to happen here, gated on outcome.paidComputeCharged, AFTER the pipeline
  // returned cleanly. That left the global and account counters out of sync whenever a paid rung threw
  // after the global charge. The per-account charge now fires INSIDE chargePaidSlot (pipeline.ts),
  // right after the global charge, so the two always move together and stay exception-consistent. This
  // route no longer post-charges the account - the pipeline owns BOTH charges at one site (L12 intact).
  // P5b Task 2: fresh-compute branch. Max-review (L1 replay append): the `computed` kind ALSO covers
  // an in-memory L1 cache REPLAY (outcome.cached === true). The sibling `persisted`/L2 branch above
  // excludes replays for exactly the staleness (an old, weaker "verified" re-minted into master truth
  // today) and per-request transaction-storm reasons - and an L1 replay is the same untrusted class,
  // so it must be excluded here too. ONLY a FRESH compute (cached === false), where the CURRENT verify
  // gate was actually applied, is trusted to write master.
  if (!outcome.cached) {
    maybeAppendMasterCatalogEntry(outcome.payload, code, codeType);
  }
  return Response.json({ ...outcome.payload, debug: { ...outcome.payload.debug, cached: outcome.cached } });
}
