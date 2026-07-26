import "server-only";

import { getAdminDb } from "@/lib/firebaseAdmin";
import { canonicalGtin } from "@/services/upc/gtin";
import { COLLECTIONS, type CatalogEntry as DbCatalogEntry } from "@/services/db/types";
import { resolveCatalogDocId } from "@/server/catalog/catalogDocId";

// Sync Truth Task 4 (owner-approved 2026-07-22, docs/superpowers/plans/2026-07-22-sync-truth-five-steps.md):
// a FREE ladder rung that consults the top-level Firestore `catalogEntries` master catalog (the same
// collection masterAppend.ts writes) BEFORE any paid rung, so a code the app (or another shop) already
// resolved and an owner already reviewed never pays again. Read via the Admin SDK (bypasses Firestore
// rules, mirrors masterAppend.ts's server-only posture) keyed by canonicalGtin - the SAME doc id scheme
// masterAppend.ts uses ("gtin_" + canonicalGtin(normalizedBarcode)), so a lookup here always finds what
// an append there wrote.
//
// RESILIENCE (plan rule 5): missing Admin credentials, a Firestore error, or a read exceeding the
// ~1500ms bound must never throw and never block the ladder - this rung silently MISSES on any of those,
// exactly like every other free rung's honest-miss posture. The timeout is a race against a plain
// setTimeout (not a Firestore-native timeout option) so it stays simple and directly testable with a
// delayed mock.

const READ_TIMEOUT_MS = 1500;

export type MasterLookupOutcome =
  | { kind: "verified"; entry: DbCatalogEntry }
  | { kind: "suggestion"; entry: DbCatalogEntry }
  | { kind: "miss" };

export interface MasterLookupDeps {
  db?: FirebaseFirestore.Firestore;
}

// In-process TTL memo (plan rule 6): repeated scans of the same code within the window never re-hit
// Firestore. Capped size with simple FIFO eviction (oldest insertion order) - a pragmatic LRU-ish bound
// that never grows unbounded under a long-running server process scanning many distinct codes.
const MEMO_TTL_MS = 5 * 60 * 1000;
const MEMO_MAX_ENTRIES = 500;

interface MemoEntry {
  outcome: MasterLookupOutcome;
  expiresAt: number;
}

const memo = new Map<string, MemoEntry>();

function memoGet(key: string): MasterLookupOutcome | undefined {
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    memo.delete(key);
    return undefined;
  }
  return hit.outcome;
}

function memoSet(key: string, outcome: MasterLookupOutcome): void {
  if (memo.size >= MEMO_MAX_ENTRIES && !memo.has(key)) {
    // Evict the oldest entry (Map preserves insertion order) to keep the memo bounded.
    const oldestKey = memo.keys().next().value;
    if (oldestKey !== undefined) memo.delete(oldestKey);
  }
  memo.set(key, { outcome, expiresAt: Date.now() + MEMO_TTL_MS });
}

/** Test-only: clear the in-process TTL memo between test files/cases. */
export function __resetMasterLookupMemoForTests(): void {
  memo.clear();
}

function classifyEntry(entry: DbCatalogEntry): MasterLookupOutcome {
  if (entry.verificationStatus !== "verified") return { kind: "miss" };
  // Fix (owner-approved, rung self-poisoning): human_verified (owner-approved via catalog-review) AND
  // ladder_verified_strong (masterAppend.ts's write gate already required app-verified exact-code
  // evidence at >= 0.8 confidence on a public barcode shape before ever writing this tier) both settle
  // verified. Without this, a code the ladder itself verified yesterday via paid rungs would replay
  // forever as a demoted 0.85 "suggestion" and the paid rungs would never run again to re-confirm it -
  // a previously-Verified code downgrading permanently. Any other/unrecognized provenanceTier on a
  // verified entry (legacy data, future tiers not yet trusted here) stays a review-first suggestion.
  if (entry.provenanceTier === "human_verified" || entry.provenanceTier === "ladder_verified_strong") {
    return { kind: "verified", entry };
  }
  return { kind: "suggestion", entry };
}

async function readEntry(canonical: string, deps: MasterLookupDeps): Promise<DbCatalogEntry | null> {
  const db = deps.db ?? getAdminDb();
  // Doc-id resolution (gtin_<canonical> primary, bare-canonical fallback for the 76,208-row legacy
  // June-25 import) lives in the shared catalogDocId.ts helper (catalog revocation round, design
  // §2.2 step 2) so this rung and the /api/catalog-dispute endpoint can never drift on which doc a
  // given canonical GTIN resolves to. Both reads share the same READ_TIMEOUT_MS envelope (the race
  // wraps readEntry).
  const resolved = await resolveCatalogDocId(db, COLLECTIONS.catalogEntries, canonical);
  if (!resolved) return null;
  return (resolved.snap.data() as DbCatalogEntry | undefined) ?? null;
}

/**
 * Consult the master catalog for a canonical GTIN. NEVER throws - any credential failure, Firestore
 * error, or a read exceeding READ_TIMEOUT_MS resolves to { kind: "miss" } so the ladder always falls
 * through cleanly to the next rung. TTL-memoized per canonical GTIN (see MEMO_TTL_MS/MEMO_MAX_ENTRIES).
 */
export async function lookupMasterCatalog(code: string, deps: MasterLookupDeps = {}): Promise<MasterLookupOutcome> {
  const canonical = canonicalGtin(code);
  if (!canonical) return { kind: "miss" };

  const memoized = memoGet(canonical);
  if (memoized) return memoized;

  let outcome: MasterLookupOutcome;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
    });
    const read = readEntry(canonical, deps);
    // Hygiene: if the timeout wins the race, this promise keeps running with no listener; without a
    // rejection handler a late Firestore failure would surface as an unhandled rejection.
    read.catch(() => {});
    const entry = await Promise.race([read, timeout]);
    if (timer) clearTimeout(timer);
    outcome = entry ? classifyEntry(entry) : { kind: "miss" };
  } catch {
    // Missing Admin credentials, a Firestore error, or any other unexpected failure: silent miss,
    // never throws, never blocks the ladder (plan rule 5).
    outcome = { kind: "miss" };
  }

  memoSet(canonical, outcome);
  return outcome;
}
