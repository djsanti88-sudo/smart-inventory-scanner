import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const spec = readFileSync(resolve("e2e/boss-barcode-corpus/local-corpus-ui.spec.ts"), "utf8");

test("timing observer identifies each scan through an exact barcode cell, not a substring", () => {
  const shorterCode = "123";
  const longerCode = `${shorterCode}4`;
  // Regression pair: `123` used to observe the row for `1234` through textContent.includes(code).
  assert.equal(longerCode.includes(shorterCode), true);
  assert.equal(longerCode === shorterCode, false);
  assert.equal(spec.includes("text.includes(code)"), false);
  assert.match(spec, /td\[data-testid\^=['"]feed-barcode-['"]\]/);
  assert.match(spec, /cell\.textContent === code/);
});

test("production corpus proof pins scanner mode through the uid-namespaced persisted store", () => {
  const scannerModeSetup = spec.match(/async function installPersistedScannerMode[\s\S]*?\n}\n\nasync function restoreScannerSubmitMode/);
  assert.ok(scannerModeSetup, "scanner mode setup helpers must exist");
  assert.equal(scannerModeSetup[0].includes("__scanStore"), false, "production mode setup cannot require a development-only window observer");
  assert.match(spec, /page\.addInitScript/);
  assert.match(spec, /sis-scan-\$\{LOCAL_CORPUS_UID\}/);
  assert.match(spec, /scannerSubmitMode:\s*["']both["']/);
  assert.match(spec, /version:\s*13/);
  assert.match(spec, /await page\.keyboard\.insertText\(warmEntry\.code\);\n\s*await expect\(page\.getByText\("1 scans"/);
  assert.match(spec, /localStorage\.setItem/);
  assert.match(spec, /localStorage\.removeItem/);
});
