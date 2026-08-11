import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force the SQLite path unavailable deterministically, same pattern as
// tireKnowledgeIndex.jsonfallback.test.ts, so lookups fall through to the in-memory JSON index and
// actually exercise getJsonIndex() (tireJsonIndexStatus() itself never loads anything - it only
// reports whatever getJsonIndex() has already cached).
vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => null,
  __resetKnowledgeDbForTests: () => {},
}));

import {
  lookupByExactBarcode,
  tireJsonIndexStatus,
  __resetTireKnowledgeCacheForTests,
} from "./tireKnowledgeIndex";
import { __resetKnowledgeDbForTests } from "@/server/knowledgeDb";

// A barcode confirmed present in the committed barcodeIndex (see tireKnowledge.generated.json);
// reused from tireKnowledgeIndex.jsonfallback.test.ts.
const KNOWN_TIRE_BARCODE = "848983006257";

describe("tireJsonIndexStatus", () => {
  beforeEach(() => {
    __resetKnowledgeDbForTests();
    __resetTireKnowledgeCacheForTests();
  });

  it("reports not_loaded before any lookup has ever touched the JSON index", () => {
    const s = tireJsonIndexStatus();
    expect(s.state).toBe("not_loaded");
    expect(s.barcodeRows).toBe(0);
    expect(s.message).toBeNull();
  });

  it("reports loaded with a real barcode row count after a successful load", async () => {
    const row = await lookupByExactBarcode(KNOWN_TIRE_BARCODE);
    expect(row).not.toBeNull(); // sanity: the fixture lookup actually hit the JSON fallback

    const s = tireJsonIndexStatus();
    expect(s.state).toBe("loaded");
    expect(s.barcodeRows).toBeGreaterThan(0);
    expect(Number.isInteger(s.barcodeRows)).toBe(true);
    expect(s.message).toBeNull();
  });

  describe("failed branch (readFileSync throws)", () => {
    const readFileSyncSpy = vi.fn();

    beforeEach(() => {
      readFileSyncSpy.mockReset().mockImplementation(() => {
        throw new Error(
          "ENOENT: libsql://private-db.turso.io authToken=TOP_SECRET open 'C:\\private\\tireKnowledge.generated.json'",
        );
      });
    });

    afterEach(() => {
      vi.doUnmock("node:fs");
      vi.resetModules();
    });

    it("reports failure with only a bounded status marker and never logs raw exception text", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return { ...actual, readFileSync: readFileSyncSpy };
      });
      vi.resetModules();
      const mod = await import("./tireKnowledgeIndex");
      mod.__resetTireKnowledgeCacheForTests();

      const row = await mod.lookupByExactBarcode(KNOWN_TIRE_BARCODE);
      expect(row).toBeNull(); // the JSON fallback failed, so there is nothing to resolve

      const s = mod.tireJsonIndexStatus();
      expect(s.state).toBe("failed");
      expect(s.barcodeRows).toBe(0);
      expect(s.message).toBe("load_failed");
      const output = warn.mock.calls.flat().join(" ");
      expect(output).not.toContain("private-db.turso.io");
      expect(output).not.toContain("TOP_SECRET");
      expect(output).not.toContain("C:\\private");
      expect(output).not.toContain("ENOENT");
    });

    it("never lets the raw exception text reach the public /api/health body", async () => {
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return { ...actual, readFileSync: readFileSyncSpy };
      });
      vi.doMock("@/lib/firebaseAdmin", () => ({
        getAdminDb: () => ({ collection: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
      }));
      vi.doMock("@/server/upc/storage", () => ({
        ladderStorage: async () => ({ get: async () => null }),
      }));
      vi.resetModules();
      const mod = await import("./tireKnowledgeIndex");
      mod.__resetTireKnowledgeCacheForTests();
      await mod.lookupByExactBarcode(KNOWN_TIRE_BARCODE); // triggers the failed load once, process-lifetime cached

      const { GET } = await import("@/app/api/health/route");
      const res = await GET(new Request("http://x/api/health"));
      const body = await res.json();

      expect(body.tireJsonIndex.state).toBe("failed");
      expect(body.tireJsonIndex.barcodeRows).toBe(0);
      expect(body.tireJsonIndex.message).toBeUndefined();
      const rawText = JSON.stringify(body);
      expect(rawText).not.toContain("ENOENT");
      expect(rawText).not.toContain("tireKnowledge.generated.json");
    });
  });
});
