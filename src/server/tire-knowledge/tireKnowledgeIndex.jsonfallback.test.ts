import { describe, it, expect, beforeEach, vi } from "vitest";

// Force the SQLite path unavailable deterministically (mirrors the real Vercel case: no DB file
// in the bundle). We mock rather than rely on `__resetKnowledgeDbForTests` alone because a local
// dev machine may have a leftover `knowledge.generated.db.gz` artifact on disk (gitignored, not
// shipped to Vercel/CI) that would let `getKnowledgeDb()` succeed and mask the JSON-fallback path
// this test exists to prove.
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => null,
  __resetKnowledgeDbForTests: () => {},
}));

import { lookupByExactBarcode, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { __resetKnowledgeDbForTests } from "@/server/knowledgeDb";

// A barcode confirmed present in the committed barcodeIndex (see tireKnowledge.generated.json).
const KNOWN_TIRE_BARCODE = "848983006257";

describe("tire index resolves from the committed JSON when SQLite is unavailable (Vercel case)", () => {
  beforeEach(() => { __resetKnowledgeDbForTests(); __resetTireKnowledgeCacheForTests(); });

  it("resolves a known committed tire barcode with no SQLite DB present", async () => {
    const row = await lookupByExactBarcode(KNOWN_TIRE_BARCODE);
    expect(row).not.toBeNull();
    expect(row!.barcode ?? KNOWN_TIRE_BARCODE).toBeTruthy();
    expect(row!.brand).toBeTruthy(); // a real row, not a stub
  });

  it("misses a code that is not in the corpus", async () => {
    const row = await lookupByExactBarcode("000000000000");
    expect(row).toBeNull();
  });
});
