import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPreviewChildEnv, readPreviewCertificationConfig, readTrustedVercelProject } from "./config.mjs";
import { normalizeVercelInspectMetadata } from "./vercel-inspect.mjs";
import { finalizePreviewReceipt } from "./finalize.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLAYWRIGHT_TEST_CLI = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));

function strictDeploymentOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Preview certification requires a strict HTTPS deployment URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.hostname === "vercel.app" || url.hostname.endsWith(".vercel.app"))) {
    throw new Error("Preview certification requires a strict HTTPS deployment URL.");
  }
  return url.origin;
}

/**
 * Windows cannot directly execute the Vercel .cmd shim with shell:false. We deliberately invoke
 * cmd.exe with a fixed command shape only after reducing the deployment URL to a strict origin,
 * so no caller-provided shell syntax can enter the command string.
 */
export function buildVercelInspectInvocation(deploymentUrl, { platform = process.platform, comSpec = process.env.ComSpec || "cmd.exe" } = {}) {
  const origin = strictDeploymentOrigin(deploymentUrl);
  if (platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", `vercel.cmd inspect ${origin} --json`],
      options: { shell: false },
    };
  }
  return { command: "vercel", args: ["inspect", origin, "--json"], options: { shell: false } };
}

export function inspectPreviewDeployment(deploymentUrl, { spawnSyncImpl = spawnSync, cwd = REPO_ROOT, platform, comSpec, trustedProject } = {}) {
  const invocation = buildVercelInspectInvocation(deploymentUrl, { platform, comSpec });
  const inspect = spawnSyncImpl(invocation.command, invocation.args, { cwd, encoding: "utf8", ...invocation.options });
  if (inspect.error || inspect.status !== 0) throw new Error("Independent Vercel inspect failed; Preview certification will not trust caller metadata.");
  let parsed;
  try { parsed = JSON.parse(String(inspect.stdout ?? "")); }
  catch { throw new Error("Independent Vercel inspect returned invalid JSON; Preview certification will not trust caller metadata."); }
  try { return normalizeVercelInspectMetadata(parsed, trustedProject ?? readTrustedVercelProject({ cwd })); }
  catch { throw new Error("Independent Vercel inspect returned invalid identity metadata; Preview certification will not trust caller metadata."); }
}

export function buildPlaywrightInvocation({ nodeExecutable = process.execPath, playwrightCliPath = PLAYWRIGHT_TEST_CLI } = {}) {
  return {
    command: nodeExecutable,
    args: [playwrightCliPath, "test", "--config=playwright.boss-preview.config.mts"],
    options: { shell: false },
  };
}

export function main({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  // The deploy wrapper supplies BOSS_PREVIEW_DEPLOYMENT_URL and its independently expected project
  // metadata. This launcher is the only entry point that sanitizes inherited provider/Turso secrets.
  Object.assign(env, buildPreviewChildEnv(env));
  const deploymentUrl = env.BOSS_PREVIEW_DEPLOYMENT_URL;
  if (typeof deploymentUrl !== "string" || deploymentUrl.length === 0) throw new Error("Preview certification requires a wrapper-emitted deployment URL.");
  env.BOSS_PREVIEW_VERCEL_INSPECT_METADATA_JSON = JSON.stringify(inspectPreviewDeployment(deploymentUrl, { spawnSyncImpl }));
  const config = readPreviewCertificationConfig(env);
  const playwright = buildPlaywrightInvocation();
  let result;
  let receipt;
  try {
    result = spawnSyncImpl(playwright.command, playwright.args, {
      cwd: REPO_ROOT, stdio: "inherit", env: buildPreviewChildEnv(env), ...playwright.options,
    });
  } finally {
    const exitCode = result?.error ? 1 : (result?.status ?? 1);
    receipt = finalizePreviewReceipt({ runId: config.runId, targetHost: deploymentUrl, playwrightExitCode: exitCode });
  }
  if (result.error) throw result.error;
  process.exitCode = receipt.status === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
