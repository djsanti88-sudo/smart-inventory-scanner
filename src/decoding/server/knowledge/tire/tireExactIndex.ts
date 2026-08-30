import "server-only";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalGtin } from "@/products/barcodes/gtin";
import type { TireKnowledgeRow } from "@/decoding/server/knowledge/tire/tireKnowledgeIndex";

type SourceScope = "global_corpus" | "authenticated_boss_corpus";

interface ExactIndexRow extends Omit<Partial<TireKnowledgeRow>, "source_count"> {
  canonical_product_uid: string;
  barcode: string;
  sourceScope: SourceScope;
  bossTrusted: boolean;
  boss_canonical_product_id?: string;
}

interface ExactIndexManifest {
  schemaVersion: string;
  generatorVersion: string;
  shardAlgorithm: string;
  bossHmacAlgorithm: string;
  bossKeyFingerprint: string;
  contentDigest: string;
  conflictLedgerCount: number;
  conflictLedgerSha256: string;
  nonGtinApprovedRows: number;
  nonGtinApprovedIdentifiers: number;
  nonGtinBlankAliasConflicts: number;
  nonGtinConflictLedgerSha256: string;
  bossCanonicalProductIds: number;
  blockedBossPackageKeys: string[];
  shardHashes: Record<string, string>;
  shardCounts: Record<string, number>;
  shardBytes: Record<string, number>;
  totalShardBytes: number;
  totalKeys: number;
}

export type TrustedExactBarcodeResult =
  | { kind: "hit"; row: TireKnowledgeRow; sourceScope: SourceScope }
  | { kind: "blocked_package"; canonicalKey: string }
  // An asset-integrity failure is not a corpus miss. Callers must stop before legacy or provider fallback.
  | { kind: "unavailable" }
  | null;

const INDEX_DIR = join(process.cwd(), "src", "decoding", "server", "knowledge", "tire", "exact-index");
const SHARDS = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(2, "0"));
// Trusted-exact scans traverse the fixed 64-shard artifact repeatedly during a physical inventory
// burst. Retaining every already hash-verified shard prevents eviction from redoing filesystem I/O,
// SHA-256, and JSON.parse on the hot path. The manifest separately caps the complete artifact at
// 40 MiB, so this remains a fixed, bounded per-process cache rather than an unbounded request cache.
const CERTIFICATION_CACHE_CAPS = new Set([16, 32, 64]);

// Only the local corpus certification runner sets both variables. Production and Preview ignore
// the cap even if inherited accidentally, retaining the established full verified-shard cache.
function maxCachedShards(): number {
  if (process.env.BOSS_CORPUS_CERTIFICATION !== "1") return SHARDS.length;
  const requested = Number(process.env.BOSS_CORPUS_EXACT_INDEX_CACHE_CAP);
  return CERTIFICATION_CACHE_CAPS.has(requested) ? requested : SHARDS.length;
}
const EXPECTED_MANIFEST_KEYS = [
  "schemaVersion", "generatorVersion", "shardAlgorithm", "bossHmacAlgorithm", "bossKeyFingerprint", "approvedCorpusSha256", "repairSha256", "reconciliationSha256",
  "collisionDispositionCount", "collisionDispositionLedgerSha256", "conflictLedgerCount", "conflictLedgerSha256", "admittedBossCodes", "acceptedSpellings",
  "bossCanonicalProductIds",
  "nonGtinApprovedRows", "nonGtinApprovedIdentifiers", "nonGtinBlankAliasConflicts", "nonGtinConflictLedgerSha256",
  "excludedCasePacks",
  "blockedBossPackageKeys", "shardHashes", "shardCounts", "shardBytes", "totalShardBytes", "totalKeys", "contentDigest",
];
const SHA256 = /^[A-F0-9]{64}$/;
const MAX_SHARD_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
type ManifestResult = { kind: "manifest"; value: ExactIndexManifest } | { kind: "unavailable" };
type ShardResult = { kind: "shard"; value: Record<string, ExactIndexRow> } | { kind: "unavailable" };
let manifestPromise: Promise<ManifestResult> | null = null;
const shardCache = new Map<string, Record<string, ExactIndexRow>>();
// At most one load per one of the 64 fixed shard names can be in flight. This
// prevents concurrent scanner lanes from repeating file I/O, hash verification,
// JSON parsing, and full-row validation for the same cold shard. Results are
// still admitted only through the existing verified LRU below.
const shardInFlight = new Map<string, Promise<ShardResult>>();

function shardFor(canonicalKey: string): string {
  return (createHash("sha256").update(canonicalKey).digest()[0] % 64).toString(16).padStart(2, "0");
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex").toUpperCase();
}

function hasExactShardKeys(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(SHARDS);
}

function isBossKeyList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((key) => typeof key === "string" && /^boss:v1:[A-F0-9]{64}$/.test(key))
    && new Set(value).size === value.length
    && value.every((key, index) => index === 0 || value[index - 1] < key);
}

function keyedDigest(key: string, domain: string, value: string): string {
  return createHmac("sha256", key).update(`${domain}\0${value}`).digest("hex").toUpperCase();
}

function bossHmacKey(): string | null {
  const key = String(process.env.BOSS_EXACT_INDEX_HMAC_KEY ?? "");
  return Buffer.byteLength(key, "utf8") >= 32 ? key : null;
}

function bossLookupKey(key: string, sourceKey: string): string {
  return `boss:v1:${keyedDigest(key, "lookup:v1", sourceKey)}`;
}

function validateManifest(value: unknown, key: string): ExactIndexManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(EXPECTED_MANIFEST_KEYS)) return null;
  if (manifest.schemaVersion !== "2.0.0" || manifest.generatorVersion !== "2.0.0"
    || manifest.shardAlgorithm !== "sha256-first-byte-mod-64-v1" || typeof manifest.contentDigest !== "string"
    || manifest.bossHmacAlgorithm !== "hmac-sha256-domain-separated-v1"
    || manifest.bossKeyFingerprint !== keyedDigest(key, "key-fingerprint:v1", "scanbin-boss-exact-index")
    || !SHA256.test(manifest.contentDigest) || !isBossKeyList(manifest.blockedBossPackageKeys)
    || !hasExactShardKeys(manifest.shardHashes) || !hasExactShardKeys(manifest.shardCounts) || !hasExactShardKeys(manifest.shardBytes)
    || !Number.isSafeInteger(manifest.totalKeys) || !Number.isSafeInteger(manifest.totalShardBytes)
    || !Number.isSafeInteger(manifest.conflictLedgerCount) || !SHA256.test(String(manifest.conflictLedgerSha256 ?? ""))
    || !Number.isSafeInteger(manifest.nonGtinApprovedRows) || !Number.isSafeInteger(manifest.nonGtinApprovedIdentifiers)
    || !Number.isSafeInteger(manifest.nonGtinBlankAliasConflicts) || !SHA256.test(String(manifest.nonGtinConflictLedgerSha256 ?? ""))
    || !Number.isSafeInteger(manifest.bossCanonicalProductIds)) return null;
  const digestInput = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "contentDigest"));
  if (sha256(JSON.stringify(digestInput)) !== manifest.contentDigest) return null;
  const shardHashes = manifest.shardHashes as Record<string, unknown>;
  const shardCounts = manifest.shardCounts as Record<string, unknown>;
  const shardBytes = manifest.shardBytes as Record<string, unknown>;
  let totalKeys = 0;
  let totalBytes = 0;
  for (const shard of SHARDS) {
    const hash = shardHashes[shard];
    const count = shardCounts[shard];
    const bytes = shardBytes[shard];
    if (typeof hash !== "string" || !SHA256.test(hash) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 3 || bytes > MAX_SHARD_BYTES) return null;
    totalKeys += count;
    totalBytes += bytes;
  }
  if (totalKeys !== manifest.totalKeys || totalBytes !== manifest.totalShardBytes || totalBytes > MAX_TOTAL_BYTES) return null;
  return manifest as unknown as ExactIndexManifest;
}

async function getManifest(): Promise<ManifestResult> {
  const key = bossHmacKey();
  if (!key) return { kind: "unavailable" };
  if (!manifestPromise) {
    manifestPromise = readFile(join(INDEX_DIR, "manifest.json"), "utf8")
      .then((raw): ManifestResult => {
        try {
          const value = validateManifest(JSON.parse(raw), key);
          return value ? { kind: "manifest", value } : { kind: "unavailable" };
        } catch {
          return { kind: "unavailable" };
        }
      })
      .catch(() => ({ kind: "unavailable" }));
  }
  const result = await manifestPromise;
  // The parsed manifest is immutable process-local state, but its Boss binding is not: environment
  // key rotation must never let a stale validated manifest turn into an ordinary exact-index miss.
  return result.kind === "manifest"
    && result.value.bossKeyFingerprint !== keyedDigest(key, "key-fingerprint:v1", "scanbin-boss-exact-index")
    ? { kind: "unavailable" }
    : result;
}

function isValidShardRow(key: string, value: unknown, shard: string): value is ExactIndexRow {
  const isGtin = canonicalGtin(key) === key;
  const privateBossKey = /^boss:v1:[A-F0-9]{64}$/.test(key);
  if (!value || typeof value !== "object" || Array.isArray(value) || (!isGtin && !privateBossKey) || shardFor(key) !== shard) return false;
  const row = value as Partial<ExactIndexRow>;
  if (typeof row.canonical_product_uid !== "string" || typeof row.barcode !== "string" || typeof row.bossTrusted !== "boolean") return false;
  if (isGtin) {
    return canonicalGtin(row.barcode) === key && row.sourceScope === "global_corpus" && row.bossTrusted === false
      && row.canonical_product_uid.length > 0 && row.boss_canonical_product_id === undefined;
  }
  return row.sourceScope === "authenticated_boss_corpus" && row.bossTrusted === true
    && row.barcode === "" && row.canonical_product_uid === ""
    && typeof row.boss_canonical_product_id === "string"
    && /^trusted-exact:v1:[A-F0-9]{32}$/.test(row.boss_canonical_product_id);
}

async function getShard(shard: string, manifest: ExactIndexManifest): Promise<ShardResult> {
  const cached = shardCache.get(shard);
  if (cached) {
    shardCache.delete(shard);
    shardCache.set(shard, cached);
    return { kind: "shard", value: cached };
  }
  const pending = shardInFlight.get(shard);
  if (pending) return pending;

  const load = (async (): Promise<ShardResult> => {
  const expectedHash = manifest.shardHashes[shard];
  if (!expectedHash) return { kind: "unavailable" };
  try {
    const raw = await readFile(join(INDEX_DIR, `${shard}.json`));
    if (raw.byteLength !== manifest.shardBytes[shard] || sha256(raw) !== expectedHash) return { kind: "unavailable" };
    const parsed = JSON.parse(raw.toString("utf8")) as Record<string, ExactIndexRow>;
    const keys = Object.keys(parsed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || keys.length !== manifest.shardCounts[shard]
      || keys.some((key, index) => (index > 0 && keys[index - 1] >= key) || !isValidShardRow(key, parsed[key], shard))) return { kind: "unavailable" };
    shardCache.set(shard, parsed);
    if (shardCache.size > maxCachedShards()) shardCache.delete(shardCache.keys().next().value!);
    return { kind: "shard", value: parsed };
  } catch {
    return { kind: "unavailable" };
  }
  })();
  shardInFlight.set(shard, load);
  try {
    return await load;
  } finally {
    shardInFlight.delete(shard);
  }
}

function toTireKnowledgeRow(row: ExactIndexRow, scannedCode?: string): TireKnowledgeRow {
  return {
    canonical_product_uid: row.sourceScope === "authenticated_boss_corpus" ? row.boss_canonical_product_id! : row.canonical_product_uid,
    brand: row.brand ?? "", brand_normalized: row.brand_normalized ?? row.brand ?? "",
    model: row.model ?? "", model_normalized: row.model_normalized ?? row.model ?? "",
    size: row.size ?? "", raw_size_text: row.raw_size_text ?? "",
    load_index: row.load_index ?? "", speed_rating: row.speed_rating ?? "", load_range: row.load_range ?? "",
    type: row.type ?? "", season: row.season ?? "", manufacturer_part_number: row.manufacturer_part_number ?? "",
    barcode: row.sourceScope === "authenticated_boss_corpus" ? String(scannedCode ?? "") : row.barcode,
    barcode_type: row.barcode_type ?? "", confidence: row.confidence ?? "",
    current_status: row.current_status ?? "", usable_for: row.usable_for ?? "",
    field_completeness_score: row.field_completeness_score ?? "", missing_fields: row.missing_fields ?? "", source_count: 0,
  };
}

/** Reads exactly one authenticated, hash-verified shard. Asset faults fail closed, distinct from a miss. */
export async function lookupTrustedExactBarcode(
  code: string,
  access: { authenticatedBossCorpus: boolean },
): Promise<TrustedExactBarcodeResult> {
  const exactCode = code.trim();
  if (!exactCode) return null;
  const canonicalKey = canonicalGtin(exactCode);
  const rawExactKey = `nongtin:${exactCode}`;
  const manifestResult = await getManifest();
  if (manifestResult.kind === "unavailable") return manifestResult;
  const manifest = manifestResult.value;
  const key = bossHmacKey();
  if (!key) return { kind: "unavailable" };
  const bossSourceKeys = [...new Set([canonicalKey, rawExactKey].filter((value): value is string => !!value))];
  const bossKeys = bossSourceKeys.map((sourceKey) => bossLookupKey(key, sourceKey));
  const blockedKey = bossKeys.find((candidate) => manifest.blockedBossPackageKeys.includes(candidate));
  if (blockedKey) {
    return { kind: "blocked_package", canonicalKey: canonicalKey ?? rawExactKey };
  }
  const lookupKeys = access.authenticatedBossCorpus
    ? [...bossKeys, ...(canonicalKey ? [canonicalKey] : [])]
    : canonicalKey ? [canonicalKey] : [];
  for (const lookupKey of lookupKeys) {
    const shardResult = await getShard(shardFor(lookupKey), manifest);
    if (shardResult.kind === "unavailable") return shardResult;
    const row = shardResult.value[lookupKey];
    if (!row) continue;

    if (row.sourceScope === "authenticated_boss_corpus" && !access.authenticatedBossCorpus) return null;
    return { kind: "hit", row: toTireKnowledgeRow(row, exactCode), sourceScope: row.sourceScope };
  }
  return null;
}

// Diagnostic 2026-08-06 (fix-wave, defect #42): every trusted-exact "unavailable" outcome used to
// collapse into one undiagnosable state with zero server-side visibility, which let a live gap - the
// deployed environment missing BOSS_EXACT_INDEX_HMAC_KEY entirely - masquerade as a silent per-scan
// failure for every allowlisted business until an owner noticed the pattern. This cheap, sync,
// no-I/O check lets the route log WHICH class of unavailability fired (missing key vs a corrupt/
// unreadable manifest or shard) without exposing the key value itself or touching the lookup contract.
export function hasBossHmacKeyConfigured(): boolean {
  return bossHmacKey() !== null;
}

export async function getTireExactIndexFingerprint(): Promise<{ schemaVersion: string; contentDigest: string } | null> {
  const manifest = await getManifest();
  return manifest.kind === "manifest" ? { schemaVersion: manifest.value.schemaVersion, contentDigest: manifest.value.contentDigest } : null;
}

export function __resetTireExactIndexCacheForTests(): void {
  manifestPromise = null;
  shardCache.clear();
  shardInFlight.clear();
}
