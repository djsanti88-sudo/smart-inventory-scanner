import type { IdentityLinkAfter, IdentityReviewAfter } from "./localRepository";

const maxCursorBytes = 512;
const cursorPattern = /^[A-Za-z0-9_-]+$/;
type ReviewCursor = { version: 1; kind: "review"; businessId: string; bucket: string; reviewId: string };
type LinkCursor = { version: 1; kind: "link"; businessId: string; normalizedValue: string; familyKey: string };

function validTuple(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function encode(value: Record<string, unknown>): string {
  const body = JSON.stringify(value);
  const raw = Buffer.from(body, "utf8").toString("base64url");
  if (Buffer.byteLength(body, "utf8") > maxCursorBytes || raw.length > maxCursorBytes || !cursorPattern.test(raw)) throw new Error("invalid_identity_cursor");
  return raw;
}

function decode(raw: string): unknown | undefined {
  if (raw.length === 0 || raw.length > maxCursorBytes || !cursorPattern.test(raw)) return undefined;
  let body: string;
  try { body = Buffer.from(raw, "base64url").toString("utf8"); } catch { return undefined; }
  if (Buffer.byteLength(body, "utf8") > maxCursorBytes || Buffer.from(body, "utf8").toString("utf8") !== body) return undefined;
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}

function exact(raw: string, value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key, index) => Object.keys(value)[index] === key)
    && Buffer.from(JSON.stringify(value), "utf8").toString("base64url") === raw;
}

export function encodeReviewCursor(businessId: string, bucket: string, after: IdentityReviewAfter): string {
  if (!validTuple(businessId) || !validTuple(bucket) || !validTuple(after.reviewId)) throw new Error("invalid_identity_cursor");
  return encode({ version: 1, kind: "review", businessId, bucket, reviewId: after.reviewId } satisfies ReviewCursor);
}

export function encodeLinkCursor(businessId: string, after: IdentityLinkAfter): string {
  if (!validTuple(businessId) || !validTuple(after.normalizedValue) || !validTuple(after.familyKey)) throw new Error("invalid_identity_cursor");
  return encode({ version: 1, kind: "link", businessId, normalizedValue: after.normalizedValue, familyKey: after.familyKey } satisfies LinkCursor);
}

export function decodeReviewCursor(raw: string | null, businessId: string, bucket: string | undefined): IdentityReviewAfter | undefined {
  if (raw === null) return undefined;
  const value = decode(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_identity_cursor");
  const record = value as Record<string, unknown>;
  if (!exact(raw, record, ["version", "kind", "businessId", "bucket", "reviewId"])
    || record.version !== 1 || record.kind !== "review" || record.businessId !== businessId || record.bucket !== (bucket ?? "") || !validTuple(record.reviewId)) throw new Error("invalid_identity_cursor");
  return { reviewId: record.reviewId };
}

export function decodeLinkCursor(raw: string | null, businessId: string): IdentityLinkAfter | undefined {
  if (raw === null) return undefined;
  const value = decode(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_identity_cursor");
  const record = value as Record<string, unknown>;
  if (!exact(raw, record, ["version", "kind", "businessId", "normalizedValue", "familyKey"])
    || record.version !== 1 || record.kind !== "link" || record.businessId !== businessId || !validTuple(record.normalizedValue) || !validTuple(record.familyKey)) throw new Error("invalid_identity_cursor");
  return { normalizedValue: record.normalizedValue, familyKey: record.familyKey };
}
