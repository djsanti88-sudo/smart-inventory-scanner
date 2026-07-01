// Release-SENTINEL: extends the release-hygiene git check (scripts/release-hygiene.mjs) into a full
// DEPLOY-SAFETY gate. Deterministic, no deps, and strictly READ-ONLY: it never calls Vercel / Firebase /
// GitHub and never deploys. It evaluates a set of FACTS into blockers + a deploy card. The cross-system
// facts that need the network (Vercel project count, production alias/SHA, Firebase prod project, branch
// protection) are PASSED IN by the caller/agent (which reads them via MCP) - the sentinel itself stays a
// pure function with no side effects, so a dry run cannot mutate anything.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SECRET_RE = /(^|\/)\.env(\.|$)|secret|credential|sa-key|service[-_]?account|adminsdk|\.pem$|\.key$|api[-_]?key/i;
const GENERATED_RE = /^(reports\/|e2e\/proof\/|\.playwright-mcp\/)|\.log$/;

/**
 * Pure evaluation: facts in -> { verdict, blockers, warnings } out. No I/O, no network, no mutation.
 */
export function evaluateSentinel(input = {}) {
  const blockers = [];
  const warnings = [];
  const B = (kind, detail) => blockers.push({ sev: "blocker", kind, detail });
  const W = (kind, detail) => warnings.push({ sev: "warn", kind, detail });

  // --- local, always-checkable ---
  if ((input.dirtyCount ?? 0) > 0) B("dirty_tree", `${input.dirtyCount} uncommitted file(s) - deploy only from a clean, committed tree.`);
  const staged = input.stagedFiles ?? [];
  const stagedGen = staged.filter((f) => GENERATED_RE.test(f));
  if (stagedGen.length) B("staged_generated", `${stagedGen.length} generated artifact(s) staged: ${stagedGen.slice(0, 3).join(", ")}`);
  const stagedSecret = staged.filter((f) => SECRET_RE.test(f));
  if (stagedSecret.length) B("staged_secret", `${stagedSecret.length} secret-risk file(s) staged: ${stagedSecret.slice(0, 3).join(", ")}`);

  // --- explicit owner approval + rollback ---
  if (!input.approvedSha) B("missing_sha_approval", "No approved SHA. Owner must confirm exactly: DEPLOY THIS SHA.");
  else if (input.head && input.approvedSha !== input.head) B("sha_mismatch", `Approved SHA ${input.approvedSha} != current HEAD ${input.head}.`);
  if (!input.rollbackTarget) B("missing_rollback", "No rollback target set (e.g. baseline-v1).");

  // --- Vercel (facts passed in by the agent) ---
  if ((input.vercelProjectCount ?? 0) > 1) B("multiple_vercel_projects", `${input.vercelProjectCount} Vercel projects deploy this repo - exactly ONE is allowed.`);
  if (input.expectedVercelProject && input.linkedVercelProject && input.expectedVercelProject !== input.linkedVercelProject) B("wrong_vercel_project", `Linked Vercel project ${input.linkedVercelProject} != expected ${input.expectedVercelProject}.`);
  if (input.expectedProdAlias && input.prodAlias && input.expectedProdAlias !== input.prodAlias) B("wrong_prod_alias", `Production alias ${input.prodAlias} != expected ${input.expectedProdAlias}.`);
  if (input.gitDirtyDeployment === true) B("dirty_deployment", "The latest production deployment was built from a dirty tree (gitDirty=1).");
  if (input.productionSha && input.approvedSha && input.productionSha !== input.approvedSha) W("prod_sha_change", `Production will change ${input.productionSha} -> ${input.approvedSha}.`);
  if (input.productionBranch && input.branch && input.branch !== input.productionBranch) B("branch_mismatch", `Current branch ${input.branch} != production branch ${input.productionBranch}.`);
  if (input.productionBranchProtected === false) B("unprotected_prod_branch", "Production branch is not protected on GitHub.");

  // --- Firebase ---
  if (input.expectedProdFirebaseProject && input.prodFirebaseProject && input.expectedProdFirebaseProject !== input.prodFirebaseProject) B("firebase_prod_mismatch", `Prod Firebase ${input.prodFirebaseProject} != expected ${input.expectedProdFirebaseProject}.`);
  if (input.firebaseRulesDrift === true) B("firebase_rules_drift", "Deployed Firestore rules differ from repo firestore.rules.");

  // --- local-proof environment safety ---
  if (input.localProof) {
    if (input.firebaseDefaultProject && !String(input.firebaseDefaultProject).startsWith("demo-")) B("firebase_not_demo", `Local proof must use a demo/emulator Firebase project, not ${input.firebaseDefaultProject}.`);
    if (input.liveAiKeysPresent && !input.isE2E) B("live_ai_during_proof", "Live AI keys present and IS_E2E is not set during local proof.");
  }

  return { verdict: blockers.length ? "BLOCKED" : "CLEAR", blockers, warnings };
}

/** Env NAMES only (values masked). Never returns a value. Scoped to the app's known env prefixes. */
export function maskEnvNames(env = {}) {
  return Object.keys(env)
    .filter((k) => /^(NEXT_PUBLIC_|GEMINI|OPENAI|AI_LOOKUP|FIREBASE|SUPABASE|GMAIL|TIRELIBRARY|FIRECRAWL|PLATFORM_OWNER)/.test(k))
    .sort()
    .map((name) => ({ name, value: "***masked***" }));
}

/** Build the deploy card (pure). Includes the mandatory owner approval phrase + masked env names. */
export function buildDeployCard(input = {}) {
  const ev = evaluateSentinel(input);
  return {
    project: input.expectedVercelProject ?? input.linkedVercelProject ?? null,
    alias: input.expectedProdAlias ?? input.prodAlias ?? null,
    branch: input.productionBranch ?? input.branch ?? null,
    commitSha: input.approvedSha ?? input.head ?? null,
    commitTitle: input.commitTitle ?? null,
    diffFromBaseline: input.diffFromBaseline ?? null,
    filesChanged: input.filesChanged ?? null,
    appBehaviorChanges: input.appBehaviorChanges ?? null,
    testsPassed: input.testsPassed ?? null,
    screenshots: input.screenshots ?? null,
    firebaseProject: input.expectedProdFirebaseProject ?? input.prodFirebaseProject ?? null,
    vercelProject: input.expectedVercelProject ?? input.linkedVercelProject ?? null,
    envNamesChecked: maskEnvNames(input.env ?? {}),
    knownRisks: input.knownRisks ?? null,
    rollbackTarget: input.rollbackTarget ?? null,
    ownerApprovalPhrase: "DEPLOY THIS SHA",
    verdict: ev.verdict,
    blockers: ev.blockers,
    warnings: ev.warnings,
  };
}

// --- CLI (read-only): gathers LOCAL facts via `git` reads + .firebaserc/.vercel; network facts come
// from SENTINEL_* env so the script never reaches out itself. Never exits non-zero unless --strict. ---
function runningAsScript() {
  const a = process.argv[1] || "";
  return a.endsWith("release-sentinel.mjs");
}
if (runningAsScript()) {
  const git = (args) => { try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return ""; } };
  const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const dirty = lines(git(["status", "--porcelain"]));
  const staged = lines(git(["diff", "--cached", "--name-only"]));
  let firebaseDefaultProject = null;
  try { firebaseDefaultProject = JSON.parse(fs.readFileSync(".firebaserc", "utf8")).projects?.default ?? null; } catch {}
  let linkedVercelProject = null;
  try { linkedVercelProject = JSON.parse(fs.readFileSync(".vercel/project.json", "utf8")).projectName ?? null; } catch {}
  const input = {
    dirtyCount: dirty.length,
    stagedFiles: staged,
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    firebaseDefaultProject,
    linkedVercelProject,
    liveAiKeysPresent: !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY),
    isE2E: process.env.IS_E2E === "1",
    localProof: process.env.SENTINEL_LOCAL_PROOF !== "0",
    approvedSha: process.env.SENTINEL_APPROVED_SHA || null,
    rollbackTarget: process.env.SENTINEL_ROLLBACK || "baseline-v1",
    vercelProjectCount: process.env.SENTINEL_VERCEL_PROJECT_COUNT ? Number(process.env.SENTINEL_VERCEL_PROJECT_COUNT) : undefined,
  };
  const out = process.argv.includes("--deploy-card") ? buildDeployCard({ ...input, env: process.env }) : evaluateSentinel(input);
  console.log(JSON.stringify(out, null, 2));
  if (process.argv.includes("--strict") && out.verdict === "BLOCKED") process.exit(1);
}
