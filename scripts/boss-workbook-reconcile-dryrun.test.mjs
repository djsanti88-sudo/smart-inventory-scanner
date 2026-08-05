import test from "node:test";
import assert from "node:assert/strict";
import { classifyRows, gs1CheckDigitValid, parseRfc4180Line } from "./boss-workbook-reconcile-dryrun.mjs";

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

test("quoted brand containing comma keeps columns aligned", () => {
  const line = '8848116004503,BH1600450,"Blackhawk, Inc",Touring,225/50R18';
  const cells = parseRfc4180Line(line);
  const cols = ["barcode", "part_number", "brand", "model", "size"];
  const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  assert.equal(row.barcode, "8848116004503");
  assert.equal(row.part_number, "BH1600450");
  assert.equal(row.brand, "Blackhawk, Inc");
  assert.equal(row.model, "Touring");
  assert.equal(row.size, "225/50R18");
});

test("check digit validity for all four GTIN lengths", () => {
  assert.equal(gs1CheckDigitValid("12345670"), true);     // EAN-8
  assert.equal(gs1CheckDigitValid("036000291452"), true); // UPC-A with leading zero
  assert.equal(gs1CheckDigitValid("4006381333931"), true); // EAN-13
  assert.equal(gs1CheckDigitValid("10012345678902"), true); // GTIN-14
});
