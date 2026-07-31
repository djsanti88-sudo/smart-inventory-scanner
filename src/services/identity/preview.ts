import { canonicalSha256, createImportIds } from "./canonical";
import { decideIdentityBatch, identityDecisionFingerprintProjection } from "./engine";
import type { IdentityCandidateSource, IdentityDecision, IdentityInput } from "./types";

const manifestVersion = "identity-preview-v1";
const maxSignedChunkBytes = 512 * 1024;

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
  scope: Pick<IdentityInput, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId">;
  orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }>;
  importerVersion: string;
  sourceFileHashes: string[];
  issuedAt: string;
  expiresAt: string;
  rows: Record<string, unknown>[];
  decisions: IdentityDecision[];
  signature: string;
}

export interface CreateIdentityPreviewInput {
  rows: IdentityInput[];
  orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }>;
  sourceFileHashes: string[];
  importerVersion: string;
  issuedAt: string;
  expiresAt: string;
  /** Test-only lowering is allowed; production callers always receive the 512 KiB ceiling. */
  maxChunkBytes?: number;
}

export interface CreateIdentityPreviewDependencies {
  source: IdentityCandidateSource;
  signer: PreviewSigner;
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
  rows: Record<string, unknown>[], decisions: IdentityDecision[], input: Pick<CreateIdentityPreviewInput, "orderedMappings" | "importerVersion">, scope: SignedPreviewChunk["scope"],
): Record<string, unknown> {
  return {
    manifestVersion,
    scope,
    importerVersion: input.importerVersion,
    orderedMappings: input.orderedMappings,
    rows,
    decisions: decisions.map(identityDecisionFingerprintProjection),
  };
}

function unsignedChunk(chunk: SignedPreviewChunk): Omit<SignedPreviewChunk, "signature"> {
  const { signature, ...unsigned } = chunk;
  void signature;
  return unsigned;
}

function parseChunk(payload: string): SignedPreviewChunk {
  let parsed: unknown;
  try { parsed = JSON.parse(payload) as unknown; } catch { throw new Error("preview_chunk_invalid_json"); }
  if (!parsed || typeof parsed !== "object") throw new Error("preview_chunk_invalid_shape");
  const chunk = parsed as Partial<SignedPreviewChunk>;
  if (chunk.manifestVersion !== manifestVersion || !Number.isSafeInteger(chunk.chunkIndex) || !Number.isSafeInteger(chunk.chunkCount)
    || chunk.chunkIndex! < 0 || chunk.chunkCount! < 1 || chunk.chunkIndex! >= chunk.chunkCount!
    || typeof chunk.sanitizedContentRootHash !== "string" || typeof chunk.importId !== "string" || typeof chunk.signature !== "string"
    || !Array.isArray(chunk.rows) || !Array.isArray(chunk.decisions) || !Array.isArray(chunk.orderedMappings) || !Array.isArray(chunk.sourceFileHashes)
    || !chunk.scope || typeof chunk.scope !== "object" || typeof chunk.issuedAt !== "string" || typeof chunk.expiresAt !== "string" || typeof chunk.importerVersion !== "string") throw new Error("preview_chunk_invalid_shape");
  return chunk as SignedPreviewChunk;
}

export async function createIdentityPreview(
  input: CreateIdentityPreviewInput,
  dependencies: CreateIdentityPreviewDependencies,
): Promise<{ preview: { importId: string; sanitizedContentRootHash: string; decisions: IdentityDecision[] }; signedPayloads: string[] }> {
  const scope = scopeFor(input.rows);
  const decisions = await decideIdentityBatch(input.rows, dependencies.source);
  const rows = input.rows.map(sanitizedRow);
  const sanitizedContentRootHash = await canonicalSha256(contentProjection(rows, decisions, input, scope));
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
    if (current && measured > cap) groups.push({ rows: [rows[index]!], decisions: [decisions[index]!] });
    else if (current) groups[groups.length - 1] = tentative;
    else groups.push(tentative);
  }
  const unsigned = groups.map((group, chunkIndex) => ({ manifestVersion, chunkIndex, chunkCount: groups.length, sanitizedContentRootHash, importId, scope, orderedMappings: input.orderedMappings, importerVersion: input.importerVersion, sourceFileHashes: input.sourceFileHashes, issuedAt: input.issuedAt, expiresAt: input.expiresAt, ...group }));
  const signedPayloads = await Promise.all(unsigned.map(async (chunk) => canonicalJson({ ...chunk, signature: await dependencies.signer.sign(canonicalJson(chunk)) })));
  return { preview: { importId, sanitizedContentRootHash, decisions }, signedPayloads };
}

/** Verifies the complete ordered signed manifest and recomputes its content identity without source bytes. */
export async function verifySignedPreviewChunks(payloads: string[], signer: PreviewSigner, now = new Date().toISOString()): Promise<SignedPreviewChunk[]> {
  if (payloads.length === 0) throw new Error("preview_chunks_incomplete");
  const chunks = payloads.map(parseChunk);
  const first = chunks[0]!;
  const expectedCount = chunks[0]!.chunkCount;
  const root = chunks[0]!.sanitizedContentRootHash;
  if (chunks.some((chunk) => chunk.sanitizedContentRootHash !== root)) throw new Error("preview_chunks_mixed_root");
  const metadata = canonicalJson({ scope: chunks[0]!.scope, orderedMappings: chunks[0]!.orderedMappings, importerVersion: chunks[0]!.importerVersion, sourceFileHashes: chunks[0]!.sourceFileHashes, issuedAt: chunks[0]!.issuedAt, expiresAt: chunks[0]!.expiresAt, importId: chunks[0]!.importId });
  if (chunks.some((chunk) => canonicalJson({ scope: chunk.scope, orderedMappings: chunk.orderedMappings, importerVersion: chunk.importerVersion, sourceFileHashes: chunk.sourceFileHashes, issuedAt: chunk.issuedAt, expiresAt: chunk.expiresAt, importId: chunk.importId }) !== metadata)) throw new Error("preview_chunks_mixed_metadata");
  if (chunks.length !== expectedCount || chunks.some((chunk) => chunk.chunkCount !== expectedCount)) throw new Error("preview_chunks_incomplete");
  for (let index = 0; index < chunks.length; index += 1) if (chunks[index]!.chunkIndex !== index) throw new Error("preview_chunks_out_of_order");
  for (const chunk of chunks) if (!await signer.verify(canonicalJson(unsignedChunk(chunk)), chunk.signature)) throw new Error("preview_signature_invalid");
  const expiry = Date.parse(first.expiresAt);
  const clock = Date.parse(now);
  if (!Number.isFinite(expiry) || !Number.isFinite(clock)) throw new Error("preview_time_invalid");
  if (expiry <= clock) throw new Error("preview_expired");
  const computed = await canonicalSha256(contentProjection(chunks.flatMap((chunk) => chunk.rows), chunks.flatMap((chunk) => chunk.decisions), first, first.scope));
  if (computed !== root) throw new Error("preview_content_root_invalid");
  return chunks;
}
