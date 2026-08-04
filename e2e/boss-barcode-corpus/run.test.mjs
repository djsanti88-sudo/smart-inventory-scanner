import assert from "node:assert/strict";
import test from "node:test";
import { spawnSpec } from "./run.mjs";
test("Windows runner calls a validated firebase.cmd through cmd.exe without corpus arguments", () => {
  const command = spawnSpec({ platform: "win32", firebase: "C:\\Users\\djsan\\AppData\\Roaming\\npm\\firebase.cmd", comspec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(command.command, "C:\\Windows\\System32\\cmd.exe"); assert.equal(command.shell, false);
  assert.match(command.args.at(-1), /^call ".*firebase\.cmd" emulators:exec/); assert.equal(command.args.join(" ").includes("BOSS_RECONCILIATION_PATH"), false);
});
test("Windows runner rejects cmd metacharacters in the launcher", () => assert.throws(() => spawnSpec({ platform: "win32", firebase: "firebase.cmd & bad" }), /plain firebase/));
