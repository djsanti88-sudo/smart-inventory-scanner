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

test("production corpus proof models a keyboard wedge with an explicit Enter terminator", () => {
  assert.match(spec, /await page\.keyboard\.insertText\(warmEntry\.code\);\s*await page\.keyboard\.press\("Enter"\);/);
});

test("visible settlement accepts a mixed terminal Verified and Counted exact-barcode feed", () => {
  assert.equal(spec.includes('feed.getByTestId("decode-row-status")'), false);
  assert.match(spec, /candidate\.querySelector\("td\[data-testid\^='feed-barcode-'\]"\)\?\.textContent === code/);
  assert.equal(spec.includes("Verified \\(app-confirmed\\)|Counted"), true);
});

test("scanner-banner proof observes transient forbidden and counted feedback during the burst", () => {
  assert.match(spec, /scannerForbidden/);
  assert.match(spec, /scannerCounted/);
  assert.match(spec, /\[data-testid="scan-status"\]/);
  assert.match(spec, /scannerCounted[^\n]*toBeGreaterThanOrEqual\(1\)/);
});

test("review proof watches the nav badge live and verifies the durable Review UI is empty", () => {
  assert.match(spec, /reviewBadgeForbidden/);
  assert.match(spec, /a\[href="\/review"\]/);
  assert.match(spec, /page\.goto\("\/review"\)/);
  assert.match(spec, /review-row-/);
  assert.match(spec, /Nothing to review/);
  assert.match(spec, /page\.goto\("\/scan"\)/);
});
