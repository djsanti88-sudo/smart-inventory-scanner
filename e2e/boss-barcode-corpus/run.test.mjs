import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { firebaseCliJs, isCliEntrypoint, spawnSpec } from "./run.mjs";
test("Windows runner invokes Firebase's JS entrypoint without cmd quoting or corpus arguments", () => {
  const command = spawnSpec({ platform: "win32", firebase: "C:\\Users\\djsan\\AppData\\Roaming\\npm\\firebase.cmd", firebaseCliJs: "C:\\Users\\djsan\\AppData\\Roaming\\npm\\node_modules\\firebase-tools\\lib\\bin\\firebase.js" });
  assert.equal(command.command, process.execPath); assert.equal(command.shell, false);
  assert.match(command.args[0], /firebase\.js$/); assert.equal(command.args.join(" ").includes("BOSS_RECONCILIATION_PATH"), false);
});
test("Windows runner rejects cmd metacharacters in the launcher", () => assert.throws(() => firebaseCliJs("firebase.cmd & bad"), /plain firebase/));
test("entrypoint comparison uses a normalized absolute file URL", () => {
  assert.equal(isCliEntrypoint(import.meta.url, fileURLToPath(import.meta.url)), true);
  assert.equal(isCliEntrypoint(import.meta.url, "not-the-runner.mjs"), false);
});
