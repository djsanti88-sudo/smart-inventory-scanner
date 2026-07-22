import { describe, it, expect, beforeEach } from "vitest";
import { lookupByExactBarcode, __resetTireKnowledgeCacheForTests } from "@/server/tire-knowledge/tireKnowledgeIndex";
import { __resetKnowledgeDbForTests } from "@/server/knowledgeDb";

// 848983006257 is committed in tireKnowledge.generated.json as a 12-digit key
// (proven 2026-07-14: padded variants MISSED before this fix).
const KNOWN_12 = "848983006257";

describe("corpus lookup is zero-padding tolerant (Z1)", () => {
  beforeEach(() => { __resetKnowledgeDbForTests(); __resetTireKnowledgeCacheForTests(); });
  it("hits the stored 12-digit key from the EAN-13 encoding", async () => {
    expect(await lookupByExactBarcode("0" + KNOWN_12)).not.toBeNull();
  });
  it("hits the stored 12-digit key from the GTIN-14 encoding", async () => {
    expect(await lookupByExactBarcode("00" + KNOWN_12)).not.toBeNull();
  });
  it("still misses a genuinely absent code", async () => {
    expect(await lookupByExactBarcode("000000000000")).toBeNull();
  });
  it("does NOT cross case-pack boundaries: a 14-digit key with indicator >=1 never matches its unit form", async () => {
    // gtinVariants preserves non-zero indicator digits (existing contract); this documents it here.
    const hitUnit = await lookupByExactBarcode(KNOWN_12);
    const hitCase = await lookupByExactBarcode("1" + "0" + KNOWN_12);
    expect(hitUnit).not.toBeNull();
    expect(hitCase).toBeNull();
  });
});
