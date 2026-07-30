import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedDeploymentUrl } from "./smoke-fingerprint.mjs";

const scriptPath = path.resolve(process.cwd(), "scripts/smoke-fingerprint.mjs");

describe("smoke fingerprint route contract", () => {
  it("expects the sessions index redirect without following it", () => {
    const source = readFileSync(scriptPath, "utf8");

    expect(source).toContain('{ path: "/sessions", expectedStatuses: [307] }');
    expect(source).toContain('redirect: "manual"');
    expect(source).not.toContain("intentional /sessions 404");
  });

  it("accepts only this project's production and preview Vercel hosts", () => {
    expect(isAllowedDeploymentUrl("https://inventory-lovat-six.vercel.app")).toBe(true);
    expect(isAllowedDeploymentUrl("https://inventory-bfkqewgfk-sharpenly.vercel.app")).toBe(true);
    expect(isAllowedDeploymentUrl("https://inventory-preview-sharpenly.vercel.app")).toBe(true);
    expect(isAllowedDeploymentUrl("https://unrelated-project.vercel.app")).toBe(false);
    expect(isAllowedDeploymentUrl("https://inventory-bfkqewgfk-sharpenly.vercel.app.evil.example")).toBe(false);
    expect(isAllowedDeploymentUrl("http://inventory-lovat-six.vercel.app")).toBe(false);
  });
});
