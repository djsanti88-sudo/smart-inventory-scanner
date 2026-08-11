import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Turbopack filesystem tracing safety", () => {
  it("opts local/dev JSON fallback reads out of whole-project tracing at the known warning sites", () => {
    expect(source("src/server/decodeCacheStore.ts")).toContain(
      "fs.readFileSync(/*turbopackIgnore: true*/ cacheFile(), \"utf8\")",
    );
    expect(source("src/server/learnedProducts.ts")).toContain(
      "fs.readFileSync(/*turbopackIgnore: true*/ storeFile(), \"utf8\")",
    );
    expect(source("src/server/share/shareTokenStore.ts")).toContain(
      "fs.existsSync(/*turbopackIgnore: true*/ file)",
    );
    expect(source("src/server/share/shareTokenStore.ts")).toContain(
      "fs.readFileSync(/*turbopackIgnore: true*/ file, \"utf8\")",
    );
    expect(source("src/services/security/aiSpendGuard.ts")).toContain(
      "fs.readFileSync(/*turbopackIgnore: true*/ file, \"utf8\")",
    );
  });
});
