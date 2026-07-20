import "server-only";
import type { AiLookupResult, DecodeDecision } from "@/types";
import { emptyResult } from "@/services/ai/provider";
import { canonicalGtin, isGtinShaped, isValidCheckDigit } from "@/services/upc/gtin";
import type { GoUpcOutcome, GoUpcProduct } from "@/services/upc/goUpcClient";
import type { GoUpcGate } from "@/services/upc/goUpcThrottle";
import type { GoUpcUsage } from "@/server/upc/goUpcUsage";
import type { LadderStorage, DecodeArchiveEntry, MissEntry } from "@/server/upc/storage";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";
import brandPrefixMap from "@/services/catalog/brandPrefixMap.json";

// The general derived single-brand prefix map (same JSON the firewall reads). Used to recover a
// prefix owner brand for the smart firewall, alongside the tire-specific prefix map.
const GENERAL_MAP = brandPrefixMap as Record<string, string>;

// The Go-UPC rung. SERVER-SIDE ONLY.
//
// Ladder position: runs AFTER local corpora/cache and the GTIN gate, BEFORE any web/AI rung. It turns
// a deterministic Go-UPC exact barcode hit into an honest "suggested" auto-apply candidate (confidence
// 0.9, subject to the same downstream store gate every suggestion passes) UNLESS a known GS1 prefix
// owner disagrees with Go-UPC's brand and the two are not the same company - then it becomes a Needs
// Review suggestion (confidence 0.4). D6/Task 2 (P5, 2026-07-20): Go-UPC is a raw paid-DB API
// self-report - the app never fetches/verifies the source page itself - so it can NEVER be "verified"
// (Resolver Trust Rules require app-verified exact-code evidence or human/account approval). A clean
// exact hit still SETTLES the ladder (pay-once) and still auto-applies its identity to the counted row
// via the >=0.8-confidence suggestion auto-apply path - only the badge/verified-flag/alias-write
// decision changes, never whether the scanned row appears or counts.
//
// Everything is injected (client, throttle, usage gate, storage, prefix lookup) so the rung is fully
// unit-testable with mocks and never touches the network, the filesystem, or process.env directly.
//
// Result shape mirrors TireKnowledgeProvider.toResult / resolveExactBarcode so the route and store
// handle a Go-UPC decode with the same AiLookupResult shape as a trusted-corpus decode; the DECISION
// status differs on purpose (suggested, not verified - see above).

const MISS_TTL_DAYS = 30;

/** The smart prefix firewall verdict for a Go-UPC hit. */
export interface PrefixVerdict {
  /** The known prefix owner brand, or null when the prefix is not in any prefix map. */
  owner: string | null;
  /** True only when a known owner CONFLICTS with Go-UPC's brand AND they are not the same company. */
  conflict: boolean;
}

/**
 * Look up the code's 7-digit prefix owner from EITHER the general derived map OR the tire prefix map,
 * then decide conflict: known owner + different brand + NOT same company family. Unknown prefix never
 * blocks (owner null, conflict false).
 */
export function evaluatePrefix(
  code: string,
  goUpcBrand: string,
  deps: { prefixLookup: (code: string) => string | null },
): PrefixVerdict {
  const owner = deps.prefixLookup(code);
  if (!owner) return { owner: null, conflict: false };
  // Same company (curated family) is never a conflict, even when the strings differ (carlstar/carlisle).
  if (sameBrandFamily(owner, goUpcBrand)) return { owner, conflict: false };
  // Reuse the general firewall's tolerant brand comparison (shared leading token = match) against the
  // KNOWN owner. It only fires when the owner brand is a known single-brand prefix and Go-UPC's brand
  // is clearly different - which is exactly this branch, since we already resolved a known owner.
  const conflict = brandPrefixConflictAgainst(owner, goUpcBrand);
  return { owner, conflict };
}

/** Tolerant brand inequality (mirrors prefixBrandConflict's comparison, minus the map lookup). */
function brandPrefixConflictAgainst(owner: string, brand: string): boolean {
  const expected = normalizeBrandLocal(owner);
  const got = normalizeBrandLocal(brand);
  if (!expected || !got) return false;
  if (got === expected) return false;
  const e0 = expected.split(" ")[0];
  const g0 = got.split(" ")[0];
  if (e0 && got.includes(e0)) return false;
  if (g0 && expected.includes(g0)) return false;
  return true;
}

function normalizeBrandLocal(b: string | undefined): string {
  return (b || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tire|tires|tyre|tyres|inc|llc|co|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Default prefix lookup: consult the tire prefix map first, then the general derived single-brand map
 * (the SAME brandPrefixMap.json the firewall uses). Both key on `code.replace(/\D/g,'').slice(0,7)`
 * (identical to prefixBrandConflict). Absence in both returns null (unknown prefix, never blocks).
 */
export function makeDefaultPrefixLookup(
  tireMap: Record<string, string>,
): (code: string) => string | null {
  return (code: string): string | null => {
    const digits = (code || "").replace(/\D/g, "");
    if (digits.length < 8) return null;
    const key = digits.slice(0, 7);
    return tireMap[key] ?? GENERAL_MAP[key] ?? null;
  };
}

export type GoUpcRungResult = {
  path:
    | "goupc_exact"
    | "goupc_inferred"
    | "goupc_prefix_conflict"
    | "goupc_miss"
    | "goupc_unavailable";
  decision?: DecodeDecision;
  results?: AiLookupResult[];
  reason: string;
};

export interface GoUpcRungDeps {
  apiKey?: string;
  client: (code: string, deps: { apiKey: string }) => Promise<GoUpcOutcome>;
  gate: GoUpcGate;
  usage: GoUpcUsage;
  storage: LadderStorage;
  /** Resolve the code's 7-digit prefix owner brand, or null when unknown. */
  prefixLookup: (code: string) => string | null;
  now?: () => Date;
  /** Archive-every-N counter seam (defaults to a module-level counter). */
  archiveEvery?: number;
}

// Archive-every-200 counter. A rung-level counter so a burst of hits archives a representative sample
// without writing every single 200 (the raw archive is evidence sampling, not a full mirror).
let archiveCounter = 0;
const DEFAULT_ARCHIVE_EVERY = 200;

function toResult(product: GoUpcProduct, code: string, canonical: string): AiLookupResult {
  const specs = product.specs.map(([, v]) => v).filter(Boolean).join(" ").trim();
  return {
    ...emptyResult(),
    productName: product.name,
    brand: product.brand,
    category: product.category,
    specsShort: specs,
    specsFull: specs,
    primaryBarcode: code,
    gtin: canonical,
    upc: product.upc || "",
    ean: product.ean || "",
    imageUrl: product.imageUrl || "",
    confidence: 0.9,
    sourceUrls: [],
    verifiedFacts: ["Go-UPC exact barcode match"],
    needsHumanReview: false,
  };
}

// D6/Task 2 (P5 Decode Trust, owner-ratified 2026-07-20): Go-UPC is a raw paid-DB API SELF-REPORT -
// the app never independently fetches/verifies the source page, so this can never be "verified" under
// the Resolver Trust Rules (app-verified exact-code evidence OR human/account approval only). Demoted
// to an honest "suggested" with evidenceStrength "none" and exactCodeEvidenceVerifiedByApp false.
// Confidence STAYS 0.9: a settled Go-UPC suggestion still STOPS the ladder (pay-once) and still
// auto-applies its identity to the counted row (>=0.8 suggestions auto-apply per CLAUDE.md) - only the
// badge/verified-flag/alias-write decision changes, never whether the row appears or counts.
function verifiedDecision(): DecodeDecision {
  return {
    status: "suggested",
    confidence: 0.9,
    reason: "Suggested by Go-UPC (exact barcode match, API self-report - not app-verified).",
    evidenceStrength: "none",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: 0.9,
      reason: "Go-UPC exact barcode.",
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
    corroborationPath: "single_source",
  };
}

function suggestionDecision(reason: string): DecodeDecision {
  return {
    status: "needs_review",
    confidence: 0.4,
    reason,
    evidenceStrength: "snippet",
    exactCodeEvidenceVerifiedByApp: false,
    crossCheck: {
      decision: "single_provider",
      confidence: 0.4,
      reason,
      brandSimilarity: 1,
      nameSimilarity: 1,
      contradictions: [],
    },
  };
}

function suggestResult(product: GoUpcProduct, code: string, canonical: string): AiLookupResult {
  return { ...toResult(product, code, canonical), confidence: 0.4, needsHumanReview: true, verifiedFacts: [] };
}

/**
 * The Go-UPC rung. Returns an explicit `reason` on EVERY branch (never silent).
 *
 * Order: GTIN gate -> spend gate -> negative miss cache -> throttled+deduped client call -> outcome
 * mapping (exact -> firewall -> verified/conflict; inferred -> suggestion; miss -> negative cache;
 * quota/auth/transient -> unavailable/fall-through).
 */
export async function goUpcRung(code: string, deps: GoUpcRungDeps): Promise<GoUpcRungResult> {
  const now = deps.now ?? (() => new Date());
  const archiveEvery = deps.archiveEvery ?? DEFAULT_ARCHIVE_EVERY;

  // Missing key: the rung is simply unavailable (loud reason, client never called).
  if (!deps.apiKey) {
    return { path: "goupc_unavailable", reason: "Go-UPC key not configured" };
  }

  // GTIN gate: non-GTIN input (wrong shape or bad check digit) is not a Go-UPC lookup. Client never called.
  if (!isGtinShaped(code) || !isValidCheckDigit(code)) {
    return { path: "goupc_miss", reason: "not a GTIN / failed check digit" };
  }
  const canonical = canonicalGtin(code);
  if (!canonical) {
    return { path: "goupc_miss", reason: "not a GTIN / failed check digit" };
  }

  // Negative cache: a genuine miss within the 30-day TTL short-circuits without spending a lookup.
  const cached = await deps.storage.readMissCache(canonical);
  if (cached && !isMissExpired(cached, now())) {
    return { path: "goupc_miss", reason: "Go-UPC negative cache hit (within 30d TTL)" };
  }

  // Spend gate: hard-stop at the monthly cap BEFORE any billed call.
  const spend = await deps.usage.canSpend();
  if (!spend.allowed) {
    return { path: "goupc_unavailable", reason: "Go-UPC monthly cap reached" };
  }

  // Throttled + deduped client call (2 req/s, in-flight dedup keyed by canonical GTIN).
  const apiKey = deps.apiKey;
  const outcome = await deps.gate.run(canonical, () => deps.client(code, { apiKey }));

  switch (outcome.kind) {
    case "hit": {
      await deps.usage.record();
      await maybeArchive(deps.storage, code, canonical, outcome.raw, now(), archiveEvery);

      if (outcome.inferred) {
        // Inferred (not an exact match) -> suggestion only. No negative cache (it was a soft hit).
        return {
          path: "goupc_inferred",
          decision: suggestionDecision("Go-UPC inferred match (not exact). Confirm before counting."),
          results: [suggestResult(outcome.product, code, canonical)],
          reason: "Go-UPC inferred match -> Needs Review suggestion",
        };
      }

      // Exact hit: smart prefix firewall. Conflict ONLY when a known prefix owner disagrees with
      // Go-UPC's brand and they are not the same company.
      const verdict = evaluatePrefix(code, outcome.product.brand, { prefixLookup: deps.prefixLookup });
      if (verdict.conflict) {
        const reason = `Go-UPC brand "${outcome.product.brand}" conflicts with prefix owner "${verdict.owner}" -> Needs Review`;
        return {
          path: "goupc_prefix_conflict",
          decision: suggestionDecision(reason),
          results: [suggestResult(outcome.product, code, canonical)],
          reason,
        };
      }

      return {
        path: "goupc_exact",
        decision: verifiedDecision(),
        results: [toResult(outcome.product, code, canonical)],
        reason: "Go-UPC exact barcode match -> verified auto-count candidate",
      };
    }

    case "miss": {
      // Genuine not-in-DB: negative-cache it for 30 days, then fall through to the next rung.
      const record: MissEntry = { canonical, missedAt: now().toISOString(), ttlDays: MISS_TTL_DAYS };
      await deps.usage.record();
      await deps.storage.writeMissCache(canonical, record);
      return { path: "goupc_miss", reason: "Go-UPC miss (negative-cached 30d) -> fall through" };
    }

    case "quota":
      return { path: "goupc_unavailable", reason: "Go-UPC quota exhausted" };

    case "auth_failed":
      return { path: "goupc_unavailable", reason: "Go-UPC auth failed" };

    case "bad_format":
      // Server said the code is malformed for it; not negative-cached (not a real product miss).
      return { path: "goupc_miss", reason: "Go-UPC rejected the code format -> fall through" };

    case "transient":
      // Timeout / 5xx / malformed JSON: fall through WITHOUT negative-caching (retry next scan).
      return { path: "goupc_unavailable", reason: `Go-UPC transient error: ${outcome.detail}` };
  }
}

function isMissExpired(entry: MissEntry, at: Date): boolean {
  const missedAt = Date.parse(entry.missedAt);
  if (Number.isNaN(missedAt)) return true; // corrupt timestamp -> treat as expired (re-check)
  const ageMs = at.getTime() - missedAt;
  return ageMs > entry.ttlDays * 24 * 60 * 60 * 1000;
}

async function maybeArchive(
  storage: LadderStorage,
  code: string,
  canonical: string,
  raw: unknown,
  at: Date,
  every: number,
): Promise<void> {
  archiveCounter += 1;
  if (archiveCounter % every !== 0) return;
  const entry: DecodeArchiveEntry = {
    code,
    canonicalGtin: canonical,
    provider: "go-upc",
    raw,
    fetchedAt: at.toISOString(),
  };
  await storage.appendArchive(entry);
}

/** Test-only: reset the archive-every counter so archive tests are deterministic. */
export function __resetArchiveCounter(): void {
  archiveCounter = 0;
}
