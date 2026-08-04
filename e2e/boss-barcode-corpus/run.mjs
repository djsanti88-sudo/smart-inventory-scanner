import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const source = process.env.BOSS_RECONCILIATION_PATH;
if (!source || !existsSync(source)) throw new Error("BOSS_RECONCILIATION_PATH must identify the private pinned reconciliation source.");
const firebase = process.env.FIREBASE_BIN || (process.platform === "win32" ? "firebase.cmd" : "firebase");
const result = spawnSync(firebase, ["emulators:exec", "--project", "demo-smart-inventory", "--only", "auth,firestore", "npx.cmd playwright test --config=playwright.corpus.config.ts"], { stdio: "inherit", shell: false, env: { ...process.env, BOSS_RECONCILIATION_PATH: source } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
