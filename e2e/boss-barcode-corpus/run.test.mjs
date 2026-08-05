import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firebaseCliJs, isCliEntrypoint, main, spawnSpec } from "./run.mjs";
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
test("Windows runner actually launches its JS CLI entrypoint with no shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-runner-"));
  try {
    const source = join(dir, "source.csv"); const sentinel = join(dir, "firebase.js");
    writeFileSync(source, "private source stays in env");
    writeFileSync(sentinel, "process.exit(process.argv.includes('emulators:exec') && process.argv.includes('npx.cmd playwright test --config=playwright.corpus.config.ts') ? 0 : 7);");
    assert.equal(main({ BOSS_RECONCILIATION_PATH: source, BOSS_CERT_RECEIPT_HMAC_KEY: "runner-unit-test-receipt-key", FIREBASE_CLI_JS: sentinel, FIREBASE_BIN: "firebase.cmd" }), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
