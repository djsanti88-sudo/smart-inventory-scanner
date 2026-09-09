import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/sync-database/mock/mockDb";

describe("provenanceTier is stamped at every provisional product birth", () => {
  it("BEHAVIOR: the ensureProvisionalCount mint carries the tier (covered end to end)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("666666666668");
    const prod = store.getState().products.find((p) => p.primaryBarcode === "666666666668")!;
    expect(prod.provenanceTier).toBe("provisional");
  });

  it("STATIC LOCK: every 'provisional: true' product literal in scanStore.ts/decodeSlice.ts stamps provenanceTier", () => {
    // Same static-source-check idiom as src/shared/privacy/keySafety.test.ts: lock the invariant at the
    // source level so a future provisional mint site cannot forget the tier.
    // PATH TRAP (see AGENTS.md "Anything that identifies code by its PATH is a trap"): wave 7 of the
    // store decomposition moved 2 of the 3 known mint sites out of scanStore.ts into
    // src/stores/scan/decodeSlice.ts (liveDecode / backgroundVerifyDeep), so this check now reads both
    // files rather than assuming every mint site still lives in scanStore.ts.
    const src =
      readFileSync(join(process.cwd(), "src", "stores", "scanStore.ts"), "utf8") +
      readFileSync(join(process.cwd(), "src", "stores", "scan", "decodeSlice.ts"), "utf8");
    const mintLines = src.split("\n").filter((l) => l.includes("provisional: true,"));
    expect(mintLines.length, "the three known mint sites exist").toBeGreaterThanOrEqual(3);
    for (const line of mintLines) {
      expect(line, `provisional mint missing provenanceTier: ${line.trim()}`).toContain('provenanceTier: "provisional"');
    }
  });
});
