import { canonicalSha256, createImportIds } from "./canonical";
import { decideIdentityBatch, identityDecisionFingerprintProjection } from "./engine";
import type { IdentityCandidateSource, IdentityDecision, IdentityInput } from "./types";

const manifestVersion = "identity-preview-v1";
const maxSignedChunkBytes = 512 * 1024;
const maxRows = 5_000;
const maxChunks = 64;
const maxSignedSetBytes = 32 * 1024 * 1024;
const maxPreviewTtlMs = 15 * 60 * 1000;
const maxFutureSkewMs = 60 * 1000;

export interface PreviewSigner {
  sign(canonicalPayload: string): Promise<string>;
  verify(canonicalPayload: string, signature: string): Promise<boolean>;
}

export interface SignedPreviewChunk {
  manifestVersion: typeof manifestVersion;
  chunkIndex: number;
  chunkCount: number;
  sanitizedContentRootHash: string;
  importId: string;
  previewFingerprint: string;
  scope: Pick<IdentityInput, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId">;
  actorId: string;
  versions: PreviewVersions;
  orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }>;
  importerVersion: string;
  sourceFileHashes: string[];
  issuedAt: string;
  expiresAt: string;
  rows: Record<string, unknown>[];
  decisions: IdentityDecision[];
  rowIds: string[];
  signature: string;
}

export interface CreateIdentityPreviewInput {
  actorId?: string;
  versions: PreviewVersions;
  rows: IdentityInput[];
  orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }>;
  sourceFileHashes: string[];
  importerVersion: string;
  issuedAt: string;
  expiresAt: string;
  /** Test-only lowering is allowed; production callers always receive the 512 KiB ceiling. */
  maxChunkBytes?: number;
}

/** Stable read-model versions are content identity; actor, provenance and time are signature-only. */
export interface PreviewVersions {
  engineVersion: string;
  pluginVersions: string[];
  catalogVersion: string;
  catalogSnapshotHash: string;
  linkVersion: string;
  linkSnapshotHash: string;
}

export interface CreateIdentityPreviewDependencies {
  source: IdentityCandidateSource;
  signer: PreviewSigner;
}

/** Values the server re-derives from its current authenticated request and read model at apply time. */
export interface PreviewVerificationExpectation {
  actorId: string;
  businessId: string;
  versions: PreviewVersions;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("preview_non_finite_value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("preview_unsupported_value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytesFromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** HMAC is deliberately injected at the pure service boundary; this helper never reads environment state. */
export async function createHmacPreviewSigner(secret: string | Uint8Array): Promise<PreviewSigner> {
  const material = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  const key = await globalThis.crypto.subtle.importKey("raw", bufferSource(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async sign(payload) {
      return base64Url(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, bufferSource(new TextEncoder().encode(payload)))));
    },
    async verify(payload, signature) {
      return globalThis.crypto.subtle.verify("HMAC", key, bufferSource(bytesFromBase64Url(signature)), bufferSource(new TextEncoder().encode(payload)));
    },
  };
}

function sanitizedRow(row: IdentityInput): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...row };
  delete sanitized.sourceFileFingerprint;
  return sanitized;
}

function scopeFor(rows: IdentityInput[]): SignedPreviewChunk["scope"] {
  const first = rows[0];
  if (!first) throw new Error("preview_rows_required");
  const scope = { businessId: first.businessId, sourceSystem: first.sourceSystem, sourceSignature: first.sourceSignature, vendorId: first.vendorId };
  if (!rows.every((row) => row.businessId === scope.businessId && row.sourceSystem === scope.sourceSystem && row.sourceSignature === scope.sourceSignature && row.vendorId === scope.vendorId)) {
    throw new Error("preview_scope_mismatch");
  }
  return scope;
}

function contentProjection(
  rows: Record<string, unknown>[], decisions: IdentityDecision[], input: Pick<CreateIdentityPreviewInput, "orderedMappings" | "importerVersion" | "versions">, scope: SignedPreviewChunk["scope"],
): Record<string, unknown> {
  return {
    manifestVersion,
    scope,
    importerVersion: input.importerVersion,
    versions: input.versions,
    orderedMappings: input.orderedMappings,
    rows,
    decisions: decisions.map(identityDecisionFingerprintProjection),
  };
}

function completeVersions(value: PreviewVersions, decisions: IdentityDecision[]): PreviewVersions {
  if (!value || ![value.engineVersion, value.catalogVersion, value.catalogSnapshotHash, value.linkVersion, value.linkSnapshotHash].every((item) => typeof item === "string" && item.length > 0)
    || !Array.isArray(value.pluginVersions) || value.pluginVersions.length === 0 || !value.pluginVersions.every((item) => typeof item === "string" && item.length > 0)) throw new Error("preview_versions_invalid");
  const pluginVersions = [...new Set(value.pluginVersions)].sort();
  if (pluginVersions.length !== value.pluginVersions.length || !decisions.every((decision) => decision.engineVersion === value.engineVersion && pluginVersions.includes(decision.pluginVersion) && decision.candidateSnapshotHash === value.catalogSnapshotHash)) throw new Error("preview_versions_mismatch");
  return { ...value, pluginVersions };
}

async function createPreviewRowId(importId: string, row: Record<string, unknown>): Promise<string> {
  return canonicalSha256({ importId, sourceFileOrdinal: row.sourceFileOrdinal, sheetName: row.sheetName, sourceRowNumber: row.sourceRowNumber, sanitizedRow: row });
}

async function createPreviewFingerprint(chunk: Omit<SignedPreviewChunk, "signature" | "previewFingerprint">): Promise<string> {
  return canonicalSha256({ manifestVersion: chunk.manifestVersion, sanitizedContentRootHash: chunk.sanitizedContentRootHash, importId: chunk.importId, scope: chunk.scope, versions: chunk.versions, rows: chunk.rows, rowIds: chunk.rowIds, decisions: chunk.decisions.map(identityDecisionFingerprintProjection) });
}

function unsignedChunk(chunk: SignedPreviewChunk): Omit<SignedPreviewChunk, "signature"> {
  const { signature, ...unsigned } = chunk;
  void signature;
  return unsigned;
}

function exactTime(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function assertPreviewTimes(issuedAt: string, expiresAt: string, now?: string): void {
  const issued = exactTime(issuedAt);
  const expires = exactTime(expiresAt);
  if (issued === undefined || expires === undefined || expires <= issued || expires - issued > maxPreviewTtlMs) throw new Error("preview_ttl_invalid");
  if (now !== undefined) {
    const clock = exactTime(now);
    if (clock === undefined) throw new Error("preview_time_invalid");
    if (issued > clock + maxFutureSkewMs) throw new Error("preview_issued_in_future");
    if (expires <= clock) throw new Error("preview_expired");
  }
}

function parseChunk(payload: string): SignedPreviewChunk {
  let parsed: unknown;
  try { parsed = JSON.parse(payload) as unknown; } catch { throw new Error("preview_chunk_invalid_json"); }
  if (!parsed || typeof parsed !== "object") throw new Error("preview_chunk_invalid_shape");
  const chunk = parsed as Partial<SignedPreviewChunk>;
  if (chunk.manifestVersion !== manifestVersion || !Number.isSafeInteger(chunk.chunkIndex) || !Number.isSafeInteger(chunk.chunkCount)
    || chunk.chunkIndex! < 0 || chunk.chunkCount! < 1 || chunk.chunkIndex! >= chunk.chunkCount!
    || typeof chunk.sanitizedContentRootHash !== "string" || typeof chunk.importId !== "string" || typeof chunk.previewFingerprint !== "string" || typeof chunk.signature !== "string"
    || !Array.isArray(chunk.rows) || !Array.isArray(chunk.decisions) || !Array.isArray(chunk.rowIds) || !Array.isArray(chunk.orderedMappings) || !Array.isArray(chunk.sourceFileHashes)
    || !chunk.scope || typeof chunk.scope !== "object" || typeof chunk.actorId !== "string" || !chunk.actorId || !chunk.versions || typeof chunk.versions !== "object" || typeof chunk.issuedAt !== "string" || typeof chunk.expiresAt !== "string" || typeof chunk.importerVersion !== "string") throw new Error("preview_chunk_invalid_shape");
  return chunk as SignedPreviewChunk;
}

export async function createIdentityPreview(
  input: CreateIdentityPreviewInput,
  dependencies: CreateIdentityPreviewDependencies,
): Promise<{ preview: { importId: string; sanitizedContentRootHash: string; decisions: IdentityDecision[] }; signedPayloads: string[] }> {
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new Error("preview_rows_required");
  if (input.actorId !== undefined && (!input.actorId || input.actorId.length > 256)) throw new Error("preview_actor_invalid");
  if (input.rows.length > maxRows) throw new Error("preview_rows_exceeded");
  assertPreviewTimes(input.issuedAt, input.expiresAt);
  const scope = scopeFor(input.rows);
  const decisions = await decideIdentityBatch(input.rows, dependencies.source);
  const versions = completeVersions(input.versions, decisions);
  const rows = input.rows.map(sanitizedRow);
  const normalizedInput = { ...input, versions };
  const sanitizedContentRootHash = await canonicalSha256(contentProjection(rows, decisions, normalizedInput, scope));
  const { importId } = await createImportIds({ sanitizedContentRootHash, orderedMappings: input.orderedMappings, businessId: scope.businessId, sourceSystem: scope.sourceSystem, vendorId: scope.vendorId, importerVersion: input.importerVersion });
  const cap = Math.min(maxSignedChunkBytes, input.maxChunkBytes ?? maxSignedChunkBytes);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("preview_chunk_limit_invalid");
  const groups: Array<{ rows: Record<string, unknown>[]; decisions: IdentityDecision[] }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const current = groups.at(-1);
    const tentative = current ? { rows: [...current.rows, rows[index]!], decisions: [...current.decisions, decisions[index]!] } : { rows: [rows[index]!], decisions: [decisions[index]!] };
    // A full metadata-bearing chunk is measured, not merely row bytes.  A lowered test cap still
    // permits one row so integrity tests can force a multi-chunk manifest.
    const measured = new TextEncoder().encode(canonicalJson({ ...tentative, scope, orderedMappings: input.orderedMappings, importerVersion: input.importerVersion, sourceFileHashes: input.sourceFileHashes, issuedAt: input.issuedAt, expiresAt: input.expiresAt })).byteLength;
    if (!current && measured > cap) throw new Error("preview_row_too_large");
    if (current && measured > cap) groups.push({ rows: [rows[index]!], decisions: [decisions[index]!] });
    else if (current) groups[groups.length - 1] = tentative;
    else groups.push(tentative);
  }
  if (groups.length > maxChunks) throw new Error("preview_chunks_exceeded");
  const unsigned = await Promise.all(groups.map(async (group, chunkIndex) => ({ manifestVersion, chunkIndex, chunkCount: groups.length, sanitizedContentRootHash, importId, scope, actorId: input.actorId ?? "local-test-actor", versions, orderedMappings: input.orderedMappings, importerVersion: input.importerVersion, sourceFileHashes: input.sourceFileHashes, issuedAt: input.issuedAt, expiresAt: input.expiresAt, rowIds: await Promise.all(group.rows.map((row) => createPreviewRowId(importId, row))), ...group })));
  const fingerprinted = await Promise.all(unsigned.map(async (chunk) => ({ ...chunk, previewFingerprint: await createPreviewFingerprint(chunk as Omit<SignedPreviewChunk, "signature" | "previewFingerprint">) })));
  const signedPayloads = await Promise.all(fingerprinted.map(async (chunk) => canonicalJson({ ...chunk, signature: await dependencies.signer.sign(canonicalJson(chunk)) })));
  if (signedPayloads.some((payload) => new TextEncoder().encode(payload).byteLength > cap)
    || signedPayloads.reduce((total, payload) => total + new TextEncoder().encode(payload).byteLength, 0) > maxSignedSetBytes) throw new Error("preview_signed_size_exceeded");
  return { preview: { importId, sanitizedContentRootHash, decisions }, signedPayloads };
}

/** Verifies the complete ordered signed manifest and recomputes its content identity without source bytes. */
export async function verifySignedPreviewChunks(
  payloads: string[],
  signer: PreviewSigner,
  now = new Date().toISOString(),
  expected?: PreviewVerificationExpectation,
): Promise<SignedPreviewChunk[]> {
  if (payloads.length === 0 || payloads.length > maxChunks) throw new Error("preview_chunks_incomplete");
  if (payloads.reduce((total, payload) => total + new TextEncoder().encode(payload).byteLength, 0) > maxSignedSetBytes) throw new Error("preview_signed_size_exceeded");
  const chunks = payloads.map(parseChunk);
  const first = chunks[0]!;
  const expectedCount = chunks[0]!.chunkCount;
  const root = chunks[0]!.sanitizedContentRootHash;
  if (chunks.some((chunk) => chunk.sanitizedContentRootHash !== root)) throw new Error("preview_chunks_mixed_root");
  const metadata = canonicalJson({ scope: chunks[0]!.scope, actorId: chunks[0]!.actorId, versions: chunks[0]!.versions, orderedMappings: chunks[0]!.orderedMappings, importerVersion: chunks[0]!.importerVersion, sourceFileHashes: chunks[0]!.sourceFileHashes, issuedAt: chunks[0]!.issuedAt, expiresAt: chunks[0]!.expiresAt, importId: chunks[0]!.importId });
  if (chunks.some((chunk) => canonicalJson({ scope: chunk.scope, actorId: chunk.actorId, versions: chunk.versions, orderedMappings: chunk.orderedMappings, importerVersion: chunk.importerVersion, sourceFileHashes: chunk.sourceFileHashes, issuedAt: chunk.issuedAt, expiresAt: chunk.expiresAt, importId: chunk.importId }) !== metadata)) throw new Error("preview_chunks_mixed_metadata");
  if (chunks.length !== expectedCount || chunks.some((chunk) => chunk.chunkCount !== expectedCount)) throw new Error("preview_chunks_incomplete");
  for (let index = 0; index < chunks.length; index += 1) if (chunks[index]!.chunkIndex !== index) throw new Error("preview_chunks_out_of_order");
  for (const chunk of chunks) if (!await signer.verify(canonicalJson(unsignedChunk(chunk)), chunk.signature)) throw new Error("preview_signature_invalid");
  if (expected?.actorId !== undefined && first.actorId !== expected.actorId) throw new Error("preview_actor_mismatch");
  if (expected?.businessId !== undefined && first.scope.businessId !== expected.businessId) throw new Error("preview_business_mismatch");
  if (expected?.versions !== undefined && canonicalJson(first.versions) !== canonicalJson(expected.versions)) throw new Error("preview_versions_stale");
  assertPreviewTimes(first.issuedAt, first.expiresAt, now);
  const rows = chunks.flatMap((chunk) => chunk.rows);
  const decisions = chunks.flatMap((chunk) => chunk.decisions);
  const rowIds = chunks.flatMap((chunk) => chunk.rowIds);
  if (rows.length === 0 || rows.length > maxRows || rows.length !== decisions.length
    || !rows.every((row, index) => row && typeof row === "object"
      && row.businessId === first.scope.businessId && row.sourceSystem === first.scope.sourceSystem
      && row.sourceSignature === first.scope.sourceSignature && row.vendorId === first.scope.vendorId
      && decisions[index]?.sourceRecordFingerprint === row.rawRecordFingerprint)) throw new Error("preview_row_decision_mismatch");
  if (!(await Promise.all(decisions.map(async (decision) => decision.decisionFingerprint === await canonicalSha256(identityDecisionFingerprintProjection(decision))))).every(Boolean)) {
    throw new Error("preview_decision_invalid");
  }
  if (rowIds.length !== rows.length || !(await Promise.all(rows.map(async (row, index) => (await createPreviewRowId(first.importId, row)) === rowIds[index]))).every(Boolean)) throw new Error("preview_row_id_invalid");
  const versions = completeVersions(first.versions, decisions);
  const { importId: recomputedImportId } = await createImportIds({ sanitizedContentRootHash: root, orderedMappings: first.orderedMappings, businessId: first.scope.businessId, sourceSystem: first.scope.sourceSystem, vendorId: first.scope.vendorId, importerVersion: first.importerVersion });
  if (recomputedImportId !== first.importId) throw new Error("preview_import_id_invalid");
  if (!(await Promise.all(chunks.map(async (chunk) => { const { previewFingerprint, ...unsigned } = unsignedChunk(chunk); return previewFingerprint === await createPreviewFingerprint(unsigned); }))).every(Boolean)) throw new Error("preview_fingerprint_invalid");
  const computed = await canonicalSha256(contentProjection(rows, decisions, { ...first, versions }, first.scope));
  if (computed !== root) throw new Error("preview_content_root_invalid");
  return chunks;
}
