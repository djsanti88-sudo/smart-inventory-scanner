import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireReceiptHmacKey } from "./receipt.mjs";

const FIREBASE_ARGS = ["emulators:exec", "--project", "demo-smart-inventory", "--only", "auth,firestore", "npx.cmd playwright test --config=playwright.corpus.config.ts"];
export function firebaseCliJs(firebaseBin = "", configuredCliJs = "") {
  if (configuredCliJs) return configuredCliJs;
  if (!firebaseBin || !/firebase\.cmd$/i.test(firebaseBin) || /["&|<>^\r\n]/.test(firebaseBin)) throw new Error("FIREBASE_BIN must be a plain firebase.cmd path or FIREBASE_CLI_JS must be set.");
  return resolve(dirname(firebaseBin), "node_modules", "firebase-tools", "lib", "bin", "firebase.js");
}
export function spawnSpec({ platform = process.platform, firebase = process.env.FIREBASE_BIN || "", firebaseCliJs: configuredCliJs = process.env.FIREBASE_CLI_JS || "" } = {}) {
  if (platform !== "win32") return { command: firebase || "firebase", args: FIREBASE_ARGS, shell: false };
  const cliJs = firebaseCliJs(firebase, configuredCliJs);
  return { command: process.execPath, args: [cliJs, ...FIREBASE_ARGS], shell: false };
}
export function main(env = process.env) {
  const source = env.BOSS_RECONCILIATION_PATH;
  if (!source || !existsSync(source)) throw new Error("BOSS_RECONCILIATION_PATH must identify the private pinned reconciliation source.");
  requireReceiptHmacKey(env.BOSS_CERT_RECEIPT_HMAC_KEY);
  const cliJs = process.platform === "win32" ? firebaseCliJs(env.FIREBASE_BIN, env.FIREBASE_CLI_JS) : "";
  if (cliJs && !existsSync(cliJs)) throw new Error("Firebase CLI JavaScript entrypoint was not found beside FIREBASE_BIN.");
  const spec = spawnSpec({ firebase: env.FIREBASE_BIN, firebaseCliJs: cliJs });
  const result = spawnSync(spec.command, spec.args, { stdio: "inherit", shell: spec.shell, env: { ...env, BOSS_RECONCILIATION_PATH: source } });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
export function isCliEntrypoint(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(resolve(argvPath)).href;
}
if (isCliEntrypoint(import.meta.url, process.argv[1])) process.exitCode = main();
