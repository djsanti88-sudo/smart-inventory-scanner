import test from "node:test";
import assert from "node:assert/strict";
import { classifyRows, gs1CheckDigitValid, parseCsvRows, parseCsv } from "./boss-workbook-reconcile-dryrun.mjs";

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
  const text = 'barcode,part_number,brand,model,size\n8848116004503,BH1600450,"Blackhawk, Inc",Touring,225/50R18\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 1);
  const row = rows[0];
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

// Fix-wave 2026-08-04: the old implementation split the WHOLE file into lines before doing any
// quote-awareness, so a quoted field with an embedded newline got cut in half - the newline inside
// the quotes became a spurious extra "row" instead of staying inside one cell. The single-pass
// parseCsvRows state machine below must keep the whole quoted field as one cell, on one row.
test("quoted field containing a newline stays one row and one cell", () => {
  const text = 'barcode,part_number,brand,model,size\n8848116004503,BH1600450,"Touring\nAll-Season",SUV,225/50R18\n8848116004504,BH1600451,Basic,Sedan,205/55R16\n';
  const rows = parseCsvRows(text);

  // header + exactly 2 data records - the embedded newline must NOT produce a 3rd/spurious row.
  assert.equal(rows.length, 3);
  const [, firstDataRow, secondDataRow] = rows;
  assert.equal(firstDataRow.length, 5);
  assert.equal(firstDataRow[2], "Touring\nAll-Season");
  assert.equal(firstDataRow[0], "8848116004503");
  assert.equal(secondDataRow[0], "8848116004504");

  const objectRows = parseCsv(text);
  assert.equal(objectRows.length, 2);
  assert.equal(objectRows[0].brand, "Touring\nAll-Season");
});

test("an unbalanced (unterminated) quote throws a clear error naming the record number", () => {
  const text = 'barcode,part_number,brand,model,size\n8848116004503,BH1600450,"Unterminated brand,Touring,225/50R18\n';
  assert.throws(
    () => parseCsvRows(text),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /unterminated quoted field/i);
      assert.match(err.message, /record 2/); // record 1 = header, record 2 = the malformed data row
      return true;
    }
  );
});

test("an unbalanced quote later in a multi-row file names the correct later record", () => {
  const text =
    'barcode,part_number,brand,model,size\n' +
    '8848116004503,BH1600450,Blackhawk,Touring,225/50R18\n' +
    '8848116004504,BH1600451,"Unterminated,Touring,225/50R18\n';
  assert.throws(() => parseCsvRows(text), /record 3/);
});

test('escaped double-quote ("") inside a quoted field decodes to a single literal quote', () => {
  const text = 'barcode,part_number,brand,model,size\n8848116004503,BH1600450,"18"" wheel brand",Touring,225/50R18\n';
  const rows = parseCsv(text);
  assert.equal(rows[0].brand, '18" wheel brand');
});

test("CRLF line endings parse identically to LF", () => {
  const text = 'barcode,part_number,brand,model,size\r\n8848116004503,BH1600450,Blackhawk,Touring,225/50R18\r\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].barcode, "8848116004503");
  assert.equal(rows[0].size, "225/50R18");
});
