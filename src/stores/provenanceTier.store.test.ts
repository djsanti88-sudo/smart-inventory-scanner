import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

  it("STATIC LOCK: every 'provisional: true' product literal under src/stores stamps provenanceTier", () => {
    // Same static-source-check idiom as src/shared/privacy/keySafety.test.ts: lock the invariant at the
    // source level so a future provisional mint site cannot forget the tier.
    //
    // PATH TRAP (see AGENTS.md "Anything that identifies code by its PATH is a trap"). This check used
    // to name scanStore.ts alone. The store decomposition then moved mint sites out into
    // scan/productDelete.ts (wave 1) and scan/decodeSlice.ts (wave 7), and the check went on passing
    // while silently covering less - it never reads a file it does not name, so a mint site that
    // forgot the tier in an unnamed file is invisible. Naming files is the bug; this now WALKS the
    // whole src/stores tree so the next wave cannot reopen the hole.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        return name.endsWith(".ts") && !name.includes(".test.") ? [full] : [];
      });
    const mintLines = walk(join(process.cwd(), "src", "stores")).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, where: `${file}:${i + 1}` }))
        .filter(({ line }) => line.includes("provisional: true,")),
    );
    // Four known mint sites as of the decode-slice wave: scanStore ensureProvisionalCount,
    // decodeSlice liveDecode + backgroundVerifyDeep, and productDelete's count-preserving ghost.
    expect(mintLines.length, "the known mint sites are still found").toBeGreaterThanOrEqual(4);
    for (const { line, where } of mintLines) {
      expect(line, `provisional mint missing provenanceTier at ${where}: ${line.trim()}`).toContain(
        'provenanceTier: "provisional"',
      );
    }
  });
});
