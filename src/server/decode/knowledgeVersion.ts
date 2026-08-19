// DECODE KNOWLEDGE VERSION + NEGATIVE-CACHE COOLDOWN (owner 2026-08-19: "a failed search is an event,
// not an identity"). The shared Turso decode cache (L2) is a platform asset every tenant replays for
// $0 - but a stored "no result", and a stored guess that never reached verified, are only as good as
// the knowledge that produced them. Both dials live HERE, in ONE place, and nothing else may mint a
// version string: every persisted row carries the version it was computed under (inside its payload's
// debug.cache, no schema change) and the pipeline re-evaluates the row once that version moves or the
// row ages past the cooldown.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hand-bumped ladder identity. BUMP THIS whenever a decode PROVIDER is added, removed, or swapped,
 * the RUNG ORDER changes, or a resolver/trust rule that decides identity changes - anything that
 * could make the ladder answer a code differently than it did before. Corpus rebuilds need no bump:
 * their own build stamps are composed into the version below.
 */
export const DECODE_LADDER_VERSION = "v1";

/**
 * How long a cached "no result" stays authoritative before the ladder is allowed one honest new try
 * (and how long a guess that paid rungs already failed to beat replays before paying is permitted
 * again). Tuning value, not a product rule - hence an env override with a 7-day default.
 */
export function decodeNegativeTtlMs(): number {
  const raw = Number(process.env.DECODE_NEGATIVE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7 * 24 * 60 * 60 * 1000;
}

// The generated corpus build stamps. Both meta files carry `generated_at` (see the generators); an
// unreadable/absent file degrades to "none" rather than throwing - a version string is a cache key,
// never a correctness gate, and a missing corpus must never break a decode.
const META_PATHS: Array<[string, string]> = [
  ["tire", join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.meta.json")],
  ["retail", join(process.cwd(), "src", "server", "retail-knowledge", "retailKnowledge.generated.meta.json")],
];

let _version: string | null = null;

function corpusStamp(file: string): string {
  try {
    const meta = JSON.parse(readFileSync(file, "utf8")) as { generated_at?: string };
    return meta.generated_at || "none";
  } catch {
    return "none";
  }
}

/**
 * The single composed knowledge version: the hand-bumped ladder version plus each corpus build stamp.
 * Read once per process (the meta files only change with a rebuild, which restarts the server).
 */
export function getDecodeKnowledgeVersion(): string {
  if (_version === null) {
    _version = [DECODE_LADDER_VERSION, ...META_PATHS.map(([name, file]) => `${name}:${corpusStamp(file)}`)].join("|");
  }
  return _version;
}

/** Test-only: forget the memoized version so a test can vary the underlying meta files. */
export function __resetKnowledgeVersionForTest(): void {
  _version = null;
}
