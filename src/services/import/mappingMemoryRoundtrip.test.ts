// src/services/import/mappingMemoryRoundtrip.test.ts
// @vitest-environment node
// Task 11 (Phase 4 Stage A ship gate), I7 proof: a remembered manual column mapping survives a
// put/get round trip through src/import/importMappingMemory.ts and re-applies to the same file's
// headers. NOTE (brief deviation): the brief named these exports `saveMapping`/`loadMapping` - the
// REAL committed exports are `putImportMappingMemory`/`getImportMappingMemory` (confirmed by reading
// src/import/importMappingMemory.ts). This file follows SOURCE. The in-memory MappingKv seam mirrors
// src/import/importMappingMemory.test.ts - no live Turso/KV is touched.
import { describe, expect, it, vi } from "vitest";
import {
  getImportMappingMemory,
  putImportMappingMemory,
  type MappingKv,
} from "@/import/importMappingMemory";
import { validateManualMapping } from "@/import/columnIntelligence";
import { buildSourceSignature, type ColumnMapping } from "@/import/importSchema";

vi.mock("server-only", () => ({}));

function memoryKv(): MappingKv {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

describe("Phase 4 Stage A mapping memory round trip (I7)", () => {
  it("PUTs a manual mapping for a sourceSignature and GETs it back deep-equal", async () => {
    const storage = memoryKv();
    const headers = ["Part Number", "Manufacturer", "Description", "Tire Size", "Quantity On Hand"];
    const sourceSignature = buildSourceSignature(headers);
    const manualMapping: ColumnMapping = { partNumber: 0, brand: 1, model: 2, size: 3, quantity: 4 };

    await putImportMappingMemory(
      {
        businessId: "biz-task11",
        sourceSignature,
        mapping: manualMapping,
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
      storage,
    );

    const loaded = await getImportMappingMemory("biz-task11", sourceSignature, storage);
    expect(loaded).not.toBeNull();
    expect(loaded?.mapping).toEqual(manualMapping);
    expect(loaded?.sourceSignature).toBe(sourceSignature);
  });

  it("the remembered mapping re-applies to the same file's headers via validateManualMapping", async () => {
    const storage = memoryKv();
    const headers = ["Part Number", "Manufacturer", "Description", "Tire Size", "Quantity On Hand"];
    const sourceSignature = buildSourceSignature(headers);
    const manualMapping: ColumnMapping = { partNumber: 0, brand: 1, model: 2, size: 3, quantity: 4 };

    await putImportMappingMemory(
      { businessId: "biz-task11", sourceSignature, mapping: manualMapping, updatedAt: "2026-07-20T00:00:00.000Z" },
      storage,
    );
    const loaded = await getImportMappingMemory("biz-task11", sourceSignature, storage);
    expect(loaded).not.toBeNull();

    // The remembered mapping must still validate against the SAME file's headers (this is the
    // "remembered" MappingSource path UniversalImportPanel.onFile takes when loadMapping resolves).
    const validation = validateManualMapping(headers, loaded!.mapping);
    expect(validation.ok).toBe(true);
  });

  it("is scoped per business: a different businessId never sees another business's remembered mapping", async () => {
    const storage = memoryKv();
    const headers = ["Part Number", "Quantity"];
    const sourceSignature = buildSourceSignature(headers);
    await putImportMappingMemory(
      { businessId: "biz-a", sourceSignature, mapping: { partNumber: 0, quantity: 1 }, updatedAt: "2026-07-20T00:00:00.000Z" },
      storage,
    );
    const crossTenant = await getImportMappingMemory("biz-b", sourceSignature, storage);
    expect(crossTenant).toBeNull();
  });
});
