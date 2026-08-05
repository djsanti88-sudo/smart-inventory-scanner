import { describe, expect, it } from "vitest";
import { tireJsonIndexStatus } from "./tireKnowledgeIndex";

describe("tireJsonIndexStatus", () => {
  it("reports not_loaded before any lookup and never throws", () => {
    const s = tireJsonIndexStatus();
    expect(["not_loaded", "loaded", "failed"]).toContain(s.state);
    expect(typeof s.barcodeRows).toBe("number");
  });
});
