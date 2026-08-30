import type { CatalogCandidate, CatalogEntry, CatalogEntryMeta, CatalogSourceTier } from "./catalogTypes";
import { isUsableProductName, cleanProductName } from "@/decoding/decode";
import { sanitizeForAiLookup } from "@/services/sanitizer";
import type { ProvenanceTier } from "@/types";

const VALID_TIERS: CatalogSourceTier[] = ["authoritative", "strong_commercial", "supporting", "weak", ""];
function validTier(t: unknown): CatalogSourceTier {
  return VALID_TIERS.includes(t as CatalogSourceTier) ? (t as CatalogSourceTier) : "";
}

// Build a CLEAN global catalog entry from a candidate. Two guarantees:
//   1. PRIVACY: only the allowed content fields are copied; businessId/prices/notes/etc. are dropped.
//   2. SAFETY: text fields run through the PII/cost sanitizer; URLs are restricted to http(s).
// Junk names are rejected upstream via isCatalogWritable (a website title must never become a catalog
// product). Pure module - no React/next, fully unit-testable.

function clean(s: unknown): string {
  return sanitizeForAiLookup(typeof s === "string" ? s : "").clean.trim();
}

/** Keep only safe absolute http(s) URLs; drop javascript:, data:, file:, and malformed values. */
export function safeHttpUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u.trim()) return null;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A name is only writable to the catalog if it passes the product-name firewall. */
export function isCatalogWritable(name: string): boolean {
  return isUsableProductName(name);
}

export function sanitizeCatalogEntry(candidate: CatalogCandidate, meta: CatalogEntryMeta): CatalogEntry {
  const normalizedBarcode = clean(candidate.normalizedBarcode) || clean(candidate.barcode);
  const verified = meta.verificationStatus === "verified";
  const aliases = Array.from(
    new Set([normalizedBarcode, ...(candidate.aliases ?? []).map((a) => clean(a))].filter(Boolean)),
  );
  return {
    barcode: clean(candidate.barcode) || normalizedBarcode,
    normalizedBarcode,
    barcodeType: clean(candidate.barcodeType),
    name: cleanProductName(clean(candidate.name)),
    brand: clean(candidate.brand),
    description: clean(candidate.description),
    category: clean(candidate.category),
    size: clean(candidate.size),
    imageUrl: safeHttpUrl(candidate.imageUrl) ?? "",
    sourceUrls: (candidate.sourceUrls ?? [])
      .map((u) => safeHttpUrl(u))
      .filter((u): u is string => !!u),
    evidenceSnippets: (candidate.evidenceSnippets ?? []).map((s) => clean(s)).filter(Boolean).slice(0, 5),
    confidence: typeof candidate.confidence === "number" ? Math.min(1, Math.max(0, candidate.confidence)) : 0,
    verificationStatus: meta.verificationStatus,
    verifiedBy: meta.verifiedBy,
    timesScanned: 1,
    timesConfirmed: verified ? 1 : 0,
    timesRejected: 0,
    firstSeenAt: meta.now,
    lastSeenAt: meta.now,
    aliases,
    conflictsWith: [],
    auditLog: [{ at: meta.now, action: verified ? "verified" : "created", by: meta.by }],
    autoVerified: !!candidate.autoVerified,
    autoVerifyReason: clean(candidate.autoVerifyReason),
    evidenceScore:
      typeof candidate.evidenceScore === "number" ? Math.min(100, Math.max(0, Math.round(candidate.evidenceScore))) : 0,
    sourceTier: validTier(candidate.sourceTier),
    evidenceSummary: clean(candidate.evidenceSummary),
    blockingReasons: (candidate.blockingReasons ?? []).map((r) => clean(r)).filter(Boolean).slice(0, 8),
  };
}

/** The db/types.ts CatalogEntry shape a repo hit (`getByBarcode`) returns, minimal subset used here. */
export interface RawCatalogHit {
  id: string;
  normalizedBarcode: string;
  name?: string;
  brand?: string;
  category?: string;
  verificationStatus?: string;
  provenanceTier?: ProvenanceTier;
}

/**
 * Map a raw repo CatalogEntry hit -> the full store CatalogEntry shape via sanitizeCatalogEntry,
 * optionally tagging the MASTER pass-through fields (masterId/masterProvenanceTier, Phase 5b GC4).
 *
 * `isMaster` must be true ONLY for hits from the tire master catalog (the default `catalogEntries`
 * collection). The retail catalog (Open Food Facts, `retailCatalogEntries`) is a separate,
 * non-master collection - tagging its hits with a master id would route them through the tire-master
 * cross-tier conflict machinery under a defaulted "corpus_verified" tier they never earned, silently
 * changing existing retail resolution behavior. Defaults to false so a caller must opt in explicitly.
 */
export function toMasterAwareStoreEntry(raw: RawCatalogHit, isMaster: boolean, nowIso: string): CatalogEntry {
  return {
    ...sanitizeCatalogEntry(
      { barcode: raw.normalizedBarcode, normalizedBarcode: raw.normalizedBarcode, name: raw.name ?? "", brand: raw.brand, category: raw.category },
      { now: nowIso, verificationStatus: raw.verificationStatus === "verified" ? "verified" : raw.verificationStatus === "conflict" ? "conflict" : "pending", verifiedBy: null, by: "trusted_source" },
    ),
    ...(isMaster ? { masterId: raw.id, masterProvenanceTier: raw.provenanceTier } : {}),
  };
}
