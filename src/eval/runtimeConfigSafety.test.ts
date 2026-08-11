import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function readJson(path: string) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, unknown>;
}

function readText(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("runtime version alignment", () => {
  it("pins the app and lockfile to the same Node major that CI proves", () => {
    const packageJson = readJson("package.json") as { engines?: { node?: string } };
    const packageLock = readJson("package-lock.json") as {
      packages?: Record<string, { engines?: { node?: string } }>;
    };

    expect(packageJson.engines?.node).toBe("24.x");
    expect(packageLock.packages?.[""]?.engines?.node).toBe("24.x");
  });

  it("runs all GitHub setup-node jobs on the pinned runtime major", () => {
    const workflows = [".github/workflows/ci.yml", ".github/workflows/playwright.yml"];

    for (const workflow of workflows) {
      const body = readText(workflow);
      expect(body).toMatch(/node-version:\s*24\b/);
      expect(body).not.toMatch(/node-version:\s*20\b/);
    }
  });
});
