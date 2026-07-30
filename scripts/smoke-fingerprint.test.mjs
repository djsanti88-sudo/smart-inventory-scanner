import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedDeploymentUrl } from "./smoke-fingerprint.mjs";

const scriptPath = path.resolve(process.cwd(), "scripts/smoke-fingerprint.mjs");
const workflowPath = path.resolve(process.cwd(), ".github/workflows/post-deploy-smoke.yml");

describe("smoke fingerprint route contract", () => {
  it("follows the sessions index redirect to its rendered page", () => {
    const source = readFileSync(scriptPath, "utf8");

    expect(source).toContain('{ path: "/sessions", expectedStatuses: [200] }');
    expect(source).toContain('return getJson(url, timeoutMs, "follow");');
    expect(source).toContain('redirect = "manual"');
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

describe("post-deploy smoke workflow contract", () => {
  it("checks out the deployment SHA without persisting repository credentials", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("github.event.repository.default_branch");
  });
});
