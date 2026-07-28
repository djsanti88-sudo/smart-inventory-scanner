#!/usr/bin/env node
// Unit tests for deriveTwinColumns (node --test): leading-zero EAN->UPC, 69x no-fabrication,
// 8/14-digit shapes, idempotency, non-numeric guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTwinColumns } from "./11_twin_columns.mjs";

test("13-digit starting with 0: drops leading zero for UPC, keeps EAN as-is", () => {
  const r = deriveTwinColumns("0036731100016");
  assert.equal(r.barcode_upc, "036731100016");
  assert.equal(r.barcode_ean13, "0036731100016");
});

test("12-digit UPC-A: mirrors itself as UPC, prefixes 0 for EAN", () => {
  const r = deriveTwinColumns("036731100016");
  assert.equal(r.barcode_upc, "036731100016");
  assert.equal(r.barcode_ean13, "0036731100016");
});

test("leading-zero EAN and its UPC form are mutually consistent (round trip)", () => {
  const ean = deriveTwinColumns("0036731100016");
  const upc = deriveTwinColumns(ean.barcode_upc);
  assert.equal(upc.barcode_upc, ean.barcode_upc);
  assert.equal(upc.barcode_ean13, ean.barcode_ean13);
});

test("13-digit NOT starting with 0 (69x China code): EAN only, UPC never fabricated", () => {
  const r = deriveTwinColumns("6901234567892");
  assert.equal(r.barcode_ean13, "6901234567892");
  assert.equal(r.barcode_upc, null, "must never fabricate a UPC-A form for a non-zero-leading 13-digit code");
});

test("8-digit code: both columns null (no valid 12/13-digit mirror)", () => {
  const r = deriveTwinColumns("12345678");
  assert.equal(r.barcode_upc, null);
  assert.equal(r.barcode_ean13, null);
});

test("14-digit code: both columns null (no valid 12/13-digit mirror)", () => {
  const r = deriveTwinColumns("12345678901234");
  assert.equal(r.barcode_upc, null);
  assert.equal(r.barcode_ean13, null);
});

test("non-numeric / alphanumeric barcode: both columns null, never mangled into a fake GTIN", () => {
  const r = deriveTwinColumns("ABC123456789");
  assert.equal(r.barcode_upc, null);
  assert.equal(r.barcode_ean13, null);
});

test("empty string / non-string input: both columns null", () => {
  assert.deepEqual(deriveTwinColumns(""), { barcode_upc: null, barcode_ean13: null });
  assert.deepEqual(deriveTwinColumns(undefined), { barcode_upc: null, barcode_ean13: null });
  assert.deepEqual(deriveTwinColumns(null), { barcode_upc: null, barcode_ean13: null });
});

test("idempotency: calling derive twice on the same barcode yields identical output", () => {
  const inputs = ["0036731100016", "036731100016", "6901234567892", "12345678", "12345678901234"];
  for (const b of inputs) {
    const first = deriveTwinColumns(b);
    const second = deriveTwinColumns(b);
    assert.deepEqual(first, second, `derivation must be deterministic for ${b}`);
  }
});
