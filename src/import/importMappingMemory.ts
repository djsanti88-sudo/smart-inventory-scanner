// src/import/importMappingMemory.ts
import "server-only";

import type { ColumnMapping, ImportField } from "@/import/importSchema";
import { IMPORT_FIELD_ORDER } from "@/import/importSchema";
import { decodeStorage, type DecodeStorage } from "@/server/decode/storage";

export type MappingKv = Pick<DecodeStorage, "get" | "set">;

export interface ImportMappingMemoryRecord {
  businessId: string;
  sourceSignature: string;
  mapping: ColumnMapping;
  updatedAt: string;
}

export function mappingMemoryKey(businessId: string, sourceSignature: string): string {
  return `import_mapping::${businessId}::${sourceSignature}`;
}

function validMapping(value: unknown): value is ColumnMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, index]) =>
    IMPORT_FIELD_ORDER.includes(key as ImportField) && Number.isSafeInteger(index) && Number(index) >= 0,
  );
}

function validRecord(value: unknown): value is ImportMappingMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.businessId === "string"
    && typeof record.sourceSignature === "string"
    && typeof record.updatedAt === "string"
    && validMapping(record.mapping);
}

export async function getImportMappingMemory(
  businessId: string,
  sourceSignature: string,
  storage?: MappingKv,
): Promise<ImportMappingMemoryRecord | null> {
  const kv = storage ?? await decodeStorage();
  const raw = await kv.get(mappingMemoryKey(businessId, sourceSignature));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!validRecord(parsed)) return null;
    if (parsed.businessId !== businessId || parsed.sourceSignature !== sourceSignature) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function putImportMappingMemory(
  record: ImportMappingMemoryRecord,
  storage?: MappingKv,
): Promise<void> {
  if (!record.businessId || !record.sourceSignature || !validMapping(record.mapping)) {
    throw new Error("Invalid import mapping memory record.");
  }
  const kv = storage ?? await decodeStorage();
  await kv.set(mappingMemoryKey(record.businessId, record.sourceSignature), JSON.stringify(record));
}
