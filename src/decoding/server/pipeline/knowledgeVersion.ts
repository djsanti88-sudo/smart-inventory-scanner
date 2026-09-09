// One version for the free knowledge and decode policy used to create a cached positive identity.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hand-bumped pipeline identity. Bump when a provider or trust rule changes. Corpus rebuilds need no bump:
 * their own build stamps are composed into the version below.
 */
export const DECODE_PIPELINE_VERSION = "v2-simple-gpt54";

// The generated corpus build stamps. Both meta files carry `generated_at` (see the generators); an
// unreadable/absent file degrades to "none" rather than throwing - a version string is a cache key,
// never a correctness gate, and a missing corpus must never break a decode.
const META_PATHS: Array<[string, string]> = [
  ["tire", join(process.cwd(), "src", "decoding", "server", "knowledge", "tire", "tireKnowledge.generated.meta.json")],
  ["retail", join(process.cwd(), "src", "decoding", "server", "knowledge", "retail", "retailKnowledge.generated.meta.json")],
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
 * The composed pipeline version plus each corpus build stamp.
 * Read once per process (the meta files only change with a rebuild, which restarts the server).
 */
export function getDecodeKnowledgeVersion(): string {
  if (_version === null) {
    _version = [DECODE_PIPELINE_VERSION, ...META_PATHS.map(([name, file]) => `${name}:${corpusStamp(file)}`)].join("|");
  }
  return _version;
}

/** Test-only: forget the memoized version so a test can vary the underlying meta files. */
export function __resetKnowledgeVersionForTest(): void {
  _version = null;
}
