import type {
  CatalogCandidate,
  CatalogEntry,
  CatalogHit,
  CatalogVerifiedBy,
  LookupDecision,
  ShopOverride,
} from "./catalogTypes";
import { sanitizeCatalogEntry } from "./sanitizeCatalog";

// Pure catalog operations over plain arrays (offline-first, framework-free, unit-testable). The store
// holds the arrays and calls these; a future cloud provider implements the same behavior remotely.

function matches(entry: CatalogEntry, codeSet: Set<string>): boolean {
  if (codeSet.has(entry.normalizedBarcode)) return true;
  return entry.aliases.some((a) => codeSet.has(a));
}

export function findEntry(catalog: CatalogEntry[], codes: string[]): CatalogEntry | undefined {
  const set = new Set(codes.filter(Boolean));
  return catalog.find((e) => matches(e, set));
}

export function findOverride(
  overrides: ShopOverride[],
  businessId: string,
  codes: string[],
): ShopOverride | undefined {
  const set = new Set(codes.filter(Boolean));
  return overrides.find((o) => o.businessId === businessId && set.has(o.normalizedBarcode));
}

function hitFromOverride(o: ShopOverride): CatalogHit {
  return {
    source: "shop_override",
    name: o.name,
    brand: o.brand,
    category: o.category,
    size: o.size,
    imageUrl: o.imageUrl,
    productUrl: o.productUrl,
    confidence: 1,
    verified: o.verified,
  };
}

function hitFromEntry(e: CatalogEntry, verified: boolean): CatalogHit {
  return {
    source: verified ? "verified_catalog" : "weak_catalog",
    name: e.name,
    brand: e.brand,
    category: e.category,
    size: e.size,
    imageUrl: e.imageUrl,
    productUrl: "",
    confidence: e.confidence,
    verified,
  };
}

/**
 * Decide an unknown code from override/catalog data. CORRECTED ORDER (owner): a private shop override
 * is checked BEFORE the shared global catalog, so an override always beats global data.
 */
export function decideLookup(
  catalog: CatalogEntry[],
  overrides: ShopOverride[],
  codes: string[],
  businessId: string,
): LookupDecision {
  // 1. Private shop override wins over everything global.
  const override = findOverride(overrides, businessId, codes);
  if (override) {
    if (override.verified) {
      return { source: "shop_override", hit: hitFromOverride(override), shouldResolveWithoutAi: true, shouldTryAi: false };
    }
    // An unverified override is a shop preference, not yet trusted -> suggest + allow AI cross-check.
    return { source: "shop_override", hit: hitFromOverride(override), shouldResolveWithoutAi: false, shouldTryAi: true };
  }

  // 2/3. Shared catalog: verified (resolve, no AI) vs weak/pending/conflict (suggest, allow AI).
  // Verified STATUS is the trust signal (set only by owner/admin/trusted source) - a verified entry
  // resolves regardless of its numeric confidence score.
  const entry = findEntry(catalog, codes);
  if (entry) {
    const verified = entry.verificationStatus === "verified";
    if (verified) {
      return { source: "verified_catalog", hit: hitFromEntry(entry, true), shouldResolveWithoutAi: true, shouldTryAi: false };
    }
    return { source: "weak_catalog", hit: hitFromEntry(entry, false), shouldResolveWithoutAi: false, shouldTryAi: true };
  }

  // 4. Nothing in override/catalog -> AI fallback (caller still applies its own AI gate).
  return { source: "none", hit: null, shouldResolveWithoutAi: false, shouldTryAi: true };
}

function verifiedByFor(by: string): CatalogVerifiedBy {
  if (by === "owner" || by === "admin" || by === "trusted_source" || by === "community" || by === "evidence_score") return by;
  return "owner";
}

/** Owner/admin/trusted verified write: create or strengthen a verified entry. */
export function upsertVerified(
  catalog: CatalogEntry[],
  candidate: CatalogCandidate,
  now: string,
  by: string,
): CatalogEntry[] {
  const clean = sanitizeCatalogEntry(candidate, { now, verificationStatus: "verified", verifiedBy: verifiedByFor(by), by });
  const codes = [clean.normalizedBarcode, ...clean.aliases];
  const idx = catalog.findIndex((e) => matches(e, new Set(codes)));
  if (idx === -1) return [...catalog, clean];

  const existing = catalog[idx];
  const merged: CatalogEntry = {
    ...existing,
    name: clean.name || existing.name,
    brand: clean.brand || existing.brand,
    description: clean.description || existing.description,
    category: clean.category || existing.category,
    size: clean.size || existing.size,
    imageUrl: clean.imageUrl || existing.imageUrl,
    sourceUrls: Array.from(new Set([...existing.sourceUrls, ...clean.sourceUrls])),
    evidenceSnippets: Array.from(new Set([...existing.evidenceSnippets, ...clean.evidenceSnippets])).slice(0, 5),
    confidence: Math.max(existing.confidence, clean.confidence),
    verificationStatus: "verified",
    verifiedBy: verifiedByFor(by),
    timesScanned: existing.timesScanned + 1,
    timesConfirmed: existing.timesConfirmed + 1,
    lastSeenAt: now,
    aliases: Array.from(new Set([...existing.aliases, ...clean.aliases])),
    auditLog: [...existing.auditLog, { at: now, action: "verified", by }],
    autoVerified: clean.autoVerified || existing.autoVerified,
    autoVerifyReason: clean.autoVerifyReason || existing.autoVerifyReason,
    evidenceScore: Math.max(existing.evidenceScore, clean.evidenceScore),
    sourceTier: clean.sourceTier || existing.sourceTier,
    evidenceSummary: clean.evidenceSummary || existing.evidenceSummary,
    blockingReasons: [],
  };
  const next = [...catalog];
  next[idx] = merged;
  return next;
}

/**
 * AI suggestion write. HARD RULE: never overwrites a VERIFIED entry's identity or status - it may only
 * record an observation/evidence on it. New or pending entries are created/updated as pending.
 */
export function applyAiCandidate(catalog: CatalogEntry[], candidate: CatalogCandidate, now: string): CatalogEntry[] {
  const clean = sanitizeCatalogEntry(candidate, { now, verificationStatus: "pending", verifiedBy: null, by: "ai" });
  const codes = [clean.normalizedBarcode, ...clean.aliases];
  const idx = catalog.findIndex((e) => matches(e, new Set(codes)));
  if (idx === -1) return [...catalog, clean];

  const existing = catalog[idx];
  if (existing.verificationStatus === "verified") {
    // Verified wins. Only observe + append non-identity evidence; identity/status untouched.
    const next = [...catalog];
    next[idx] = {
      ...existing,
      timesScanned: existing.timesScanned + 1,
      lastSeenAt: now,
      sourceUrls: Array.from(new Set([...existing.sourceUrls, ...clean.sourceUrls])),
      evidenceSnippets: Array.from(new Set([...existing.evidenceSnippets, ...clean.evidenceSnippets])).slice(0, 5),
      auditLog: [...existing.auditLog, { at: now, action: "ai_observed", by: "ai" }],
    };
    return next;
  }

  // pending/conflict: may refine fields, stays pending.
  const next = [...catalog];
  next[idx] = {
    ...existing,
    name: clean.confidence > existing.confidence ? clean.name : existing.name,
    brand: clean.confidence > existing.confidence ? clean.brand : existing.brand,
    confidence: Math.max(existing.confidence, clean.confidence),
    timesScanned: existing.timesScanned + 1,
    lastSeenAt: now,
    sourceUrls: Array.from(new Set([...existing.sourceUrls, ...clean.sourceUrls])),
    auditLog: [...existing.auditLog, { at: now, action: "ai_suggested", by: "ai" }],
  };
  return next;
}

/** A confirmed resolution sourced from the catalog/override: bump usage, never change identity. */
export function observeScan(catalog: CatalogEntry[], codes: string[], now: string): CatalogEntry[] {
  const idx = catalog.findIndex((e) => matches(e, new Set(codes.filter(Boolean))));
  if (idx === -1) return catalog;
  const existing = catalog[idx];
  const next = [...catalog];
  next[idx] = {
    ...existing,
    timesScanned: existing.timesScanned + 1,
    timesConfirmed: existing.timesConfirmed + 1,
    lastSeenAt: now,
    auditLog: [...existing.auditLog, { at: now, action: "observed", by: "system" }],
  };
  return next;
}
