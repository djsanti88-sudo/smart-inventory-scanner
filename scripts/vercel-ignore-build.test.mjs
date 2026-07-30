import { describe, expect, it } from "vitest";
import { shouldIgnoreBuild } from "./vercel-ignore-build.mjs";

describe("Vercel ignored-build policy", () => {
  it("ignores documentation-only commits", () => {
    expect(shouldIgnoreBuild(["docs/DEPLOY_TRUTH.md", "README.md"])).toBe(true);
  });

  it("builds when any runtime or deployment file changes", () => {
    expect(shouldIgnoreBuild(["docs/DEPLOY_TRUTH.md", "src/app/page.tsx"])).toBe(false);
    expect(shouldIgnoreBuild(["vercel.json"])).toBe(false);
    expect(shouldIgnoreBuild([".github/workflows/post-deploy-smoke.yml"])).toBe(false);
  });

  it("builds when the changed-file set cannot prove a docs-only commit", () => {
    expect(shouldIgnoreBuild([])).toBe(false);
  });
});
