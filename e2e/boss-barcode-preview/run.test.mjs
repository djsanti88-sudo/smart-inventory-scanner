import assert from "node:assert/strict";
import test from "node:test";

import { buildPlaywrightInvocation, buildVercelInspectInvocation, inspectPreviewDeployment } from "./run.mjs";

const URL = "https://inventory-mllr0663p-sharpenly.vercel.app";
const INSPECT_JSON = JSON.stringify({
  id: "dpl_1", name: "inventory-preview", url: `${URL}/`, target: "preview", readyState: "READY",
});
const TRUSTED_PROJECT = { projectId: "prj_preview_expected", projectName: "inventory-preview" };

test("Windows inspect uses an explicit cmd.exe command with a strict URL and no shell option", () => {
  assert.deepEqual(buildVercelInspectInvocation(URL, { platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe" }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", `vercel.cmd inspect ${URL} --json`],
    options: { shell: false },
  });
  assert.doesNotMatch(buildVercelInspectInvocation(URL, { platform: "win32" }).args[3], /"/);
  assert.throws(() => buildVercelInspectInvocation("https://preview.vercel.app/&whoami", { platform: "win32" }), /strict HTTPS/i);
});

test("Playwright launch pins the @playwright/test CLI instead of an ambiguous npx bin", () => {
  assert.deepEqual(buildPlaywrightInvocation({ nodeExecutable: "node.exe", playwrightCliPath: "C:/repo/node_modules/@playwright/test/cli.js" }), {
    command: "node.exe",
    args: ["C:/repo/node_modules/@playwright/test/cli.js", "test", "--config=playwright.boss-preview.config.mts"],
    options: { shell: false },
  });
});

test("inspect spawns the platform-safe command, parses JSON, and fails closed on nonzero or malformed output", () => {
  const calls = [];
  const metadata = inspectPreviewDeployment(URL, {
    platform: "win32",
    comSpec: "cmd.exe",
    cwd: "C:/repo",
    trustedProject: TRUSTED_PROJECT,
    spawnSyncImpl: (...args) => { calls.push(args); return { status: 0, stdout: INSPECT_JSON }; },
  });
  assert.deepEqual(metadata, { url: URL, target: "preview", readyState: "READY", projectId: "prj_preview_expected" });
  assert.deepEqual(calls[0], ["cmd.exe", ["/d", "/s", "/c", `vercel.cmd inspect ${URL} --json`], { cwd: "C:/repo", encoding: "utf8", shell: false }]);
  assert.throws(() => inspectPreviewDeployment(URL, { spawnSyncImpl: () => ({ status: 1, stdout: "" }) }), /Independent Vercel inspect failed/);
  assert.throws(() => inspectPreviewDeployment(URL, { spawnSyncImpl: () => ({ status: 0, stdout: "not-json" }) }), /invalid JSON/i);
  assert.throws(() => inspectPreviewDeployment(URL, { trustedProject: { ...TRUSTED_PROJECT, projectName: "other" }, spawnSyncImpl: () => ({ status: 0, stdout: INSPECT_JSON }) }), /invalid identity metadata/i);
});
