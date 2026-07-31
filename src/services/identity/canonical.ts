import type { CreateImportIdsInput, IdentifierType, IdentityInput, ImportIds } from "./types";

const domainSeparator = "identity-import-v1";
const gtinLengths = new Set([8, 12, 13, 14]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
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

export function validateIdentityInput(input: IdentityInput): string[] {
  const errors: string[] = [];
  for (const field of ["businessId", "sourceSystem", "sourceSignature", "vendorId"] as const) {
    if (!input[field].trim()) errors.push(`${field} is required`);
  }
  if (!Number.isFinite(input.quantity) || input.quantity < 0) {
    errors.push("quantity must be a finite non-negative number");
  }
  if (input.unitOfMeasure !== undefined && input.unitOfMeasure.toLowerCase() !== "each") {
    errors.push("unitOfMeasure must be each");
  }
  input.identifiers.forEach((identifier, index) => {
    if (!identifier.raw.trim() || !identifier.normalized.trim() || !identifier.source.trim()) {
      errors.push(`identifiers[${index}] is malformed`);
    }
    if (
      (identifier.type === "gtin" || identifier.type === "upc" || identifier.type === "ean") &&
      !isValidGtin(identifier.normalized)
    ) {
      errors.push(`identifiers[${index}] has an invalid GTIN`);
    }
  });
  return errors;
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
