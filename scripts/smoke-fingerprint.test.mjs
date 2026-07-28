import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/smoke-fingerprint.mjs");

describe("smoke fingerprint route contract", () => {
  it("expects the real sessions index route to be available", () => {
    const source = readFileSync(scriptPath, "utf8");

    expect(source).toContain('{ path: "/sessions", expectedStatuses: [200] }');
    expect(source).not.toContain("intentional /sessions 404");
  });
});
