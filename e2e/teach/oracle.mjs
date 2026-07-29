// Correctness oracle for the Teach Bot harness.
//
// Ground truth comes from the app's OWN product corpus (see
// testing/app-knowledge/oracle-codes.json, built by
// scripts/build-oracle-codes.mjs). A code that exists in the corpus SHOULD
// resolve to that corpus product's identity when scanned. This module is the
// PURE comparison + loading layer: no Playwright, no I/O beyond an optional
// tolerant file read, so it is fully unit-testable.
//
// compareIdentity(observed, expected) -> { match, reason }
// loadOracle(path) -> parsed array (tolerant of missing/bad files -> [])

import { readFileSync } from 'node:fs';

/** Normalize a name/brand string: lowercase, strip punctuation, collapse ws. */
function normalize(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Coerce a string-or-{name,brand} identity into a { name, brand } shape. */
function toIdentity(value) {
  if (value == null) return { name: '', brand: '' };
  if (typeof value === 'string') return { name: value, brand: '' };
  if (typeof value === 'object') {
    return {
      name: value.name == null ? '' : String(value.name),
      brand: value.brand == null ? '' : String(value.brand),
    };
  }
  return { name: String(value), brand: '' };
}

/** Meaningful tokens for name-overlap: drop very short / noise tokens. */
function meaningfulTokens(normalizedName) {
  if (!normalizedName) return [];
  return normalizedName.split(' ').filter((t) => t.length >= 3);
}

/**
 * Compare an OBSERVED product identity (read from the running app) against an
 * EXPECTED identity (from the corpus oracle).
 *
 * Rules:
 *  - If the expected identity is empty (nothing to check), it's a match
 *    (the oracle has no ground truth to contradict).
 *  - If expected is non-empty but observed is empty/missing, it's a definite
 *    miss (the app returned nothing for a code we have ground truth for).
 *  - A brand match (both non-empty, equal after normalize) counts as a match.
 *  - Otherwise a significant name-token overlap (>= 2 shared meaningful tokens,
 *    or a single shared token when either side has only one meaningful token)
 *    counts as a match.
 *  - Anything else is a non-match.
 *
 * @param {string | {name?: string, brand?: string}} observed
 * @param {string | {name?: string, brand?: string}} expected
 * @returns {{ match: boolean, reason: string }}
 */
export function compareIdentity(observed, expected) {
  const obs = toIdentity(observed);
  const exp = toIdentity(expected);

  const obsName = normalize(obs.name);
  const obsBrand = normalize(obs.brand);
  const expName = normalize(exp.name);
  const expBrand = normalize(exp.brand);

  const expEmpty = expName === '' && expBrand === '';
  const obsEmpty = obsName === '' && obsBrand === '';

  if (expEmpty) {
    return { match: true, reason: 'no expected identity to check (oracle has no ground truth for this code)' };
  }

  if (obsEmpty) {
    return { match: false, reason: 'observed identity is empty/missing while expected is non-empty (definite miss)' };
  }

  // Brand match.
  if (obsBrand !== '' && expBrand !== '' && obsBrand === expBrand) {
    return { match: true, reason: `brand match ("${obsBrand}")` };
  }

  // Brand appears inside the other side's name (common: observed name carries
  // the brand while expected only sets a brand field, or vice versa).
  if (expBrand !== '' && obsName.split(' ').includes(expBrand)) {
    return { match: true, reason: `expected brand ("${expBrand}") found in observed name` };
  }
  if (obsBrand !== '' && expName.split(' ').includes(obsBrand)) {
    return { match: true, reason: `observed brand ("${obsBrand}") found in expected name` };
  }

  // Name-token overlap.
  const obsTokens = meaningfulTokens(obsName);
  const expTokens = meaningfulTokens(expName);
  const expSet = new Set(expTokens);
  const shared = obsTokens.filter((t) => expSet.has(t));
  const uniqueShared = new Set(shared);

  const minTokenCount = Math.min(obsTokens.length, expTokens.length);
  // Two or more shared meaningful tokens is a strong overlap. A single shared
  // token only counts when at least one side is a single-token identity (so a
  // one-word product name can still match), never for two long, mostly-
  // disjoint names sharing one incidental token.
  const strongOverlap = uniqueShared.size >= 2;
  const singleTokenMatch = uniqueShared.size >= 1 && minTokenCount <= 1;

  if (strongOverlap || singleTokenMatch) {
    return {
      match: true,
      reason: `name-token overlap (${uniqueShared.size} shared: ${[...uniqueShared].join(', ')})`,
    };
  }

  return {
    match: false,
    reason: `no match (brands "${obsBrand || '-'}" vs "${expBrand || '-'}" differ; ${uniqueShared.size} shared name tokens)`,
  };
}

/**
 * Load the oracle dataset (a JSON array) from disk. Tolerant of a missing,
 * unreadable, malformed, or non-array file: returns [] instead of throwing so
 * the harness degrades gracefully when the oracle has not been built.
 *
 * @param {string} path
 * @returns {Array<{code: string, expectedName: string, expectedBrand: string, source: string}>}
 */
export function loadOracle(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
