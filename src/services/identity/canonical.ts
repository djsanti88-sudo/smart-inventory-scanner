import type { CreateImportIdsInput, IdentifierType, IdentityInput, ImportIds } from "./types";

const domainSeparator = "identity-import-v1";
const gtinLengths = new Set([8, 12, 13, 14]);
const identifierTypes = new Set<IdentifierType>([
  "gtin",
  "upc",
  "ean",
  "barcode",
  "manufacturer_part_number",
  "vendor_sku",
  "oem_number",
  "internal_code",
  "shelf_code",
  "source_alias",
]);
const namespacedIdentifierTypes = new Set<IdentifierType>([
  "barcode",
  "manufacturer_part_number",
  "vendor_sku",
  "oem_number",
  "internal_code",
  "shelf_code",
  "source_alias",
]);

function unsupportedCanonicalValue(): never {
  throw new TypeError("Unsupported canonical JSON value");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : unsupportedCanonicalValue();
  if (typeof value !== "object") return unsupportedCanonicalValue();
  if (ancestors.has(value)) return unsupportedCanonicalValue();
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return unsupportedCanonicalValue();
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      return unsupportedCanonicalValue();
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function canonicalSha256(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(`${domainSeparator}:${canonicalJson(value)}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeIdentifier(type: IdentifierType, raw: string): string {
  const value = raw.trim();
  return type === "gtin" || type === "upc" || type === "ean" ? value.replace(/[\s-]/g, "") : value;
}

export function isValidGtin(value: string): boolean {
  if (!/^\d+$/.test(value) || !gtinLengths.has(value.length)) return false;

  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return false;
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function requiredString(record: Record<string, unknown>, field: string, errors: string[]): void {
  if (typeof record[field] !== "string" || !record[field].trim()) errors.push(`${field} is required`);
}

function validateIdentityInputUnsafe(input: unknown): string[] {
  if (!isPlainObject(input)) return ["input must be a plain object"];

  const errors: string[] = [];
  for (const field of [
    "businessId",
    "sourceSystem",
    "sourceSignature",
    "vendorId",
    "sourceFileFingerprint",
    "sheetName",
    "rawRecordFingerprint",
  ]) {
    requiredString(input, field, errors);
  }
  if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0) {
    errors.push("quantity must be a finite non-negative number");
  }
  if (!Number.isInteger(input.sourceFileOrdinal) || (input.sourceFileOrdinal as number) < 0) {
    errors.push("sourceFileOrdinal must be a non-negative integer");
  }
  if (!Number.isInteger(input.sourceRowNumber) || (input.sourceRowNumber as number) <= 0) {
    errors.push("sourceRowNumber must be a positive integer");
  }
  if (!isPlainObject(input.attributes)) errors.push("attributes must be a plain object");
  if (
    input.unitOfMeasure !== undefined &&
    (typeof input.unitOfMeasure !== "string" || input.unitOfMeasure.toLowerCase() !== "each")
  ) {
    errors.push("unitOfMeasure must be each");
  }
  if (!Array.isArray(input.identifiers)) {
    errors.push("identifiers must be an array");
    return errors;
  }
  input.identifiers.forEach((identifier: unknown, index: number) => {
    if (!isPlainObject(identifier)) {
      errors.push(`identifiers[${index}] is malformed`);
      return;
    }
    const type = identifier.type;
    if (typeof type !== "string" || !identifierTypes.has(type as IdentifierType)) {
      errors.push(`identifiers[${index}] is malformed`);
      return;
    }
    for (const field of ["raw", "normalized", "source", "evidenceAuthority", "evidenceId", "evidenceVersion"]) {
      if (typeof identifier[field] !== "string" || !identifier[field].trim()) {
        errors.push(`identifiers[${index}] is malformed`);
        break;
      }
    }
    const identifierType = type as IdentifierType;
    if (
      namespacedIdentifierTypes.has(identifierType) &&
      (typeof identifier.namespace !== "string" || !identifier.namespace.trim())
    ) {
      errors.push(`identifiers[${index}] requires a namespace for ${identifierType}`);
    }
    if (
      (identifierType === "gtin" || identifierType === "upc" || identifierType === "ean") &&
      (typeof identifier.normalized !== "string" || !isValidGtin(identifier.normalized))
    ) {
      errors.push(`identifiers[${index}] has an invalid GTIN`);
    }
  });
  return errors;
}

export function validateIdentityInput(input: IdentityInput): string[];
export function validateIdentityInput(input: unknown): string[];
export function validateIdentityInput(input: unknown): string[] {
  try {
    return validateIdentityInputUnsafe(input);
  } catch {
    return ["input could not be validated"];
  }
}

export async function createImportIds(input: CreateImportIdsInput): Promise<ImportIds> {
  const { sanitizedContentRootHash, orderedMappings, businessId, sourceSystem, vendorId, importerVersion } = input;
  return {
    importId: await canonicalSha256({
      sanitizedContentRootHash,
      orderedMappings,
      businessId,
      sourceSystem,
      vendorId,
      importerVersion,
    }),
  };
}
