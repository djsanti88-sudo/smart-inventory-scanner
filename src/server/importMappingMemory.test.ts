// src/server/importMappingMemory.test.ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  getImportMappingMemory,
  mappingMemoryKey,
  putImportMappingMemory,
  type MappingKv,
} from "@/server/importMappingMemory";

vi.mock("server-only", () => ({}));

function memoryKv(): MappingKv {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

describe("importMappingMemory", () => {
  it("scopes the key by business and source signature", () => {
    expect(mappingMemoryKey("biz-a", "source-1")).toBe("import_mapping::biz-a::source-1");
    expect(mappingMemoryKey("biz-b", "source-1")).not.toBe(mappingMemoryKey("biz-a", "source-1"));
  });

  it("round-trips a valid mapping", async () => {
    const storage = memoryKv();
    await putImportMappingMemory({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
      updatedAt: "2026-07-20T12:00:00.000Z",
    }, storage);
    await expect(getImportMappingMemory("biz-a", "source-1", storage)).resolves.toEqual({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("fails closed on corrupt or cross-account records", async () => {
    const corrupt: MappingKv = {
      get: async () => JSON.stringify({ businessId: "biz-b", sourceSignature: "source-1", mapping: {} }),
      set: async () => undefined,
    };
    await expect(getImportMappingMemory("biz-a", "source-1", corrupt)).resolves.toBeNull();
  });
});
