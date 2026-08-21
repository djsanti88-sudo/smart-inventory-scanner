import { describe, it, expect } from "vitest";
import { evaluateSentinel, buildDeployCard, maskEnvNames } from "./release-sentinel.mjs";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/release-sentinel.mjs");

function runScript(cwd, env = {}, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    cwd,
    shell: false,
    env: {
      ...process.env,
      ...env,
    },
  });
}

function makeCleanGitRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "release-sentinel-cli-"));
  fs.writeFileSync(path.join(cwd, "README.md"), "lock check fixtures\n");
  execSync("git init", { cwd });
  execSync("git -c user.name=ci -c user.email=ci@example.com add README.md", { cwd });
  execSync("git -c user.name=ci -c user.email=ci@example.com commit -m boot", { cwd });
  const head = execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
  return { cwd, head };
}

// release-sentinel is a PURE deploy-safety gate: facts in -> blockers/card out, no network, no mutation.
// A fully clean, single-source-of-truth, demo-Firebase, owner-approved input is the only CLEAR state.
const clean = {
  dirtyCount: 0,
  stagedFiles: [],
  branch: "master",
  head: "abc123",
  approvedSha: "abc123",
  rollbackTarget: "baseline-v1",
  vercelProjectCount: 1,
  productionBranch: "master",
  localProof: true,
  firebaseDefaultProject: "demo-smart-inventory",
  liveAiKeysPresent: false,
  isE2E: false,
};

describe("release-sentinel (dry-run deploy gate; read-only, no mutation)", () => {
  it("a fully clean input is CLEAR (no blockers)", () => {
    expect(evaluateSentinel(clean).verdict).toBe("CLEAR");
  });

  it("BLOCKS when a duplicate Vercel project is detected", () => {
    const r = evaluateSentinel({ ...clean, vercelProjectCount: 2 });
    expect(r.verdict).toBe("BLOCKED");
    expect(r.blockers.map((b) => b.kind)).toContain("multiple_vercel_projects");
  });

  it("BLOCKS a dirty working tree", () => {
    expect(evaluateSentinel({ ...clean, dirtyCount: 3 }).blockers.map((b) => b.kind)).toContain("dirty_tree");
  });

  it("BLOCKS staged generated artifacts and staged secret-risk files", () => {
    const r = evaluateSentinel({ ...clean, stagedFiles: ["e2e/proof/x.png", ".env.local"] });
    const kinds = r.blockers.map((b) => b.kind);
    expect(kinds).toContain("staged_generated");
    expect(kinds).toContain("staged_secret");
  });

  it("BLOCKS a missing SHA approval and a SHA mismatch", () => {
    expect(evaluateSentinel({ ...clean, approvedSha: null }).blockers.map((b) => b.kind)).toContain("missing_sha_approval");
    expect(evaluateSentinel({ ...clean, approvedSha: "different" }).blockers.map((b) => b.kind)).toContain("sha_mismatch");
  });

  it("BLOCKS a missing rollback target", () => {
    expect(evaluateSentinel({ ...clean, rollbackTarget: null }).blockers.map((b) => b.kind)).toContain("missing_rollback");
  });

  it("BLOCKS live AI keys present during local proof", () => {
    expect(evaluateSentinel({ ...clean, liveAiKeysPresent: true, isE2E: false }).blockers.map((b) => b.kind)).toContain("live_ai_during_proof");
  });

  it("BLOCKS a non-demo Firebase project during local proof", () => {
    expect(evaluateSentinel({ ...clean, firebaseDefaultProject: "smart-inventory-scanner-app" }).blockers.map((b) => b.kind)).toContain("firebase_not_demo");
  });

  it("masks env VALUES - returns names only, never a secret value", () => {
    const masked = maskEnvNames({ OPENAI_API_KEY: "super-secret-123", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "p", UNRELATED: "x" });
    expect(masked.find((e) => e.name === "OPENAI_API_KEY")?.value).toBe("***masked***");
    expect(JSON.stringify(masked)).not.toContain("super-secret-123");
    expect(masked.some((e) => e.name === "UNRELATED")).toBe(false); // only app-relevant names are listed
  });

  it("deploy card carries the owner approval phrase + masked env, and is BLOCKED without approval", () => {
    const card = buildDeployCard({ ...clean, approvedSha: null, env: { OPENAI_API_KEY: "leak-me" } });
    expect(card.ownerApprovalPhrase).toBe("DEPLOY THIS SHA");
    expect(card.verdict).toBe("BLOCKED");
    expect(JSON.stringify(card)).not.toContain("leak-me");
    expect(card.rollbackTarget).toBe("baseline-v1");
  });

  it("flags git read failures as a BLOCKED verdict with an explicit reason", () => {
    const blocked = evaluateSentinel({
      ...clean,
      gitReadFailures: [
        { command: "git status --porcelain", error: "git: failed" },
      ],
    });
    expect(blocked.verdict).toBe("BLOCKED");
    expect(blocked.blockers.map((b) => b.kind)).toContain("git_read_failed");
  });

  it("exits 0 for CLEAR on script invocation", () => {
    const { cwd, head } = makeCleanGitRepo();
    const result = runScript(cwd, {
      SENTINEL_APPROVED_SHA: head,
      SENTINEL_ROLLBACK: "baseline-v1",
    });
    expect(result.status).toBe(0);
  });

  it("exits 1 for BLOCKED by default when rollback target is missing", () => {
    const { cwd, head } = makeCleanGitRepo();
    const result = runScript(cwd, {
      SENTINEL_APPROVED_SHA: head,
    });
    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body.verdict).toBe("BLOCKED");
    expect(body.blockers.map((b) => b.kind)).toContain("missing_rollback");
  });

  it("allows BLOCKED inputs with --report-only", () => {
    const { cwd, head } = makeCleanGitRepo();
    const result = runScript(cwd, {
      SENTINEL_APPROVED_SHA: head,
    }, ["--report-only"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.verdict).toBe("BLOCKED");
    expect(body.blockers.map((b) => b.kind)).toContain("missing_rollback");
  });

  it("is BLOCKED when git calls fail (and exposes git_read_failed)", () => {
    const { cwd, head } = makeCleanGitRepo();
    const result = runScript(
      cwd,
      {
        SENTINEL_APPROVED_SHA: head,
        SENTINEL_ROLLBACK: "baseline-v1",
        PATH: "",
      },
    );
    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body.verdict).toBe("BLOCKED");
    expect(body.blockers.map((b) => b.kind)).toContain("git_read_failed");
  });
});
