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

  it("STATIC LOCK: every 'provisional: true' product literal in scanStore.ts stamps provenanceTier", () => {
    // Same static-source-check idiom as src/shared/privacy/keySafety.test.ts: lock the invariant at the
    // source level so a future provisional mint site cannot forget the tier.
    const src = readFileSync(join(process.cwd(), "src", "stores", "scanStore.ts"), "utf8");
    const mintLines = src.split("\n").filter((l) => l.includes("provisional: true,"));
    expect(mintLines.length, "the three known mint sites exist").toBeGreaterThanOrEqual(3);
    for (const line of mintLines) {
      expect(line, `provisional mint missing provenanceTier: ${line.trim()}`).toContain('provenanceTier: "provisional"');
    }
  });
});
