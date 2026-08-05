import test from "node:test";
import assert from "node:assert/strict";
import { classifyRows, gs1CheckDigitValid } from "./boss-workbook-reconcile-dryrun.mjs";

test("valid EAN-13 is accepted", () => {
  const out = classifyRows([{ barcode: "8848116004503", part_number: "BH1600450", brand: "Blackhawk", model: "", size: "" }]);
  assert.equal(out.accepted.length, 1);
});

test("10-digit code goes to needsReview, blank goes to blanks", () => {
  const out = classifyRows([
    { barcode: "3220015959", part_number: "BH1600448", brand: "Blackhawk", model: "", size: "" },
    { barcode: "", part_number: "BH1600449", brand: "Blackhawk", model: "", size: "" },
  ]);
  assert.equal(out.needsReview.length, 1);
  assert.equal(out.blanks.length, 1);
});

test("check digit is enforced, not just shape", () => {
  assert.equal(gs1CheckDigitValid("8848116004503"), true);
  assert.equal(gs1CheckDigitValid("8848116004504"), false);
});
