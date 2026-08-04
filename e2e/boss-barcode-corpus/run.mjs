import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WINDOWS_FIREBASE_COMMAND = "emulators:exec --project demo-smart-inventory --only auth,firestore npx.cmd playwright test --config=playwright.corpus.config.ts";
export function spawnSpec({ platform = process.platform, firebase = process.env.FIREBASE_BIN || "", comspec = process.env.ComSpec || "cmd.exe" } = {}) {
  if (platform !== "win32") return { command: firebase || "firebase", args: ["emulators:exec", "--project", "demo-smart-inventory", "--only", "auth,firestore", "npx playwright test --config=playwright.corpus.config.ts"], shell: false };
  const launcher = firebase || "firebase.cmd";
  // The launcher path never receives corpus data and is rejected if it contains cmd metacharacters.
  if (/["&|<>^\r\n]/.test(launcher) || !/firebase\.cmd$/i.test(launcher)) throw new Error("FIREBASE_BIN must be a plain firebase.cmd path.");
  return { command: comspec, args: ["/d", "/s", "/c", `call "${launcher}" ${WINDOWS_FIREBASE_COMMAND}`], shell: false };
}
export function main(env = process.env) {
  const source = env.BOSS_RECONCILIATION_PATH;
  if (!source || !existsSync(source)) throw new Error("BOSS_RECONCILIATION_PATH must identify the private pinned reconciliation source.");
  const spec = spawnSpec({ firebase: env.FIREBASE_BIN, comspec: env.ComSpec });
  const result = spawnSync(spec.command, spec.args, { stdio: "inherit", shell: spec.shell, env: { ...env, BOSS_RECONCILIATION_PATH: source } });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
export function isCliEntrypoint(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(resolve(argvPath)).href;
}
if (isCliEntrypoint(import.meta.url, process.argv[1])) process.exitCode = main();
