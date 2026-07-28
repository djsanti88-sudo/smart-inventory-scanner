import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GENERATED_JSON_PATH = join(process.cwd(), "src", "server", "tire-knowledge", "tireKnowledge.generated.json");

type TireKnowledgePayload = {
  barcodeIndex: Record<string, {
    confidence?: string;
    source_count?: number;
    source?: string;
  }>;
};

describe("tire knowledge corpus integrity invariants", () => {
  it("verified records have at least one source counted", async () => {
    const raw = await readFile(GENERATED_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as TireKnowledgePayload;

    const violations = Object.entries(parsed.barcodeIndex)
      .filter(([, row]) => row.confidence?.startsWith("verified_") && (row.source_count ?? 0) < 1)
      .map(([barcode, row]) => ({
        barcode,
        confidence: row.confidence,
        source_count: row.source_count ?? 0,
        source: row.source,
      }));

    expect(violations, `Verified rows with source_count < 1: ${JSON.stringify(violations.slice(0, 5))}`).toHaveLength(0);
  });
});
