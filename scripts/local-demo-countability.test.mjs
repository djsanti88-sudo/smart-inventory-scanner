import assert from "node:assert/strict";
import { test } from "vitest";

import { isCountableLocalDemoRow } from "./local-demo-countability.ts";

function checkDigit(body) {
  let sum = 0;
  for (let index = body.length - 1, weight = 3; index >= 0; index -= 1, weight = 4 - weight) sum += Number(body[index]) * weight;
  return String((10 - (sum % 10)) % 10);
}

function trustedRow(size) {
  const body = "70000000000";
  return {
    barcode: `${body}${checkDigit(body)}`,
    barcode_type: "upc",
    canonical_product_uid: `TIRE_${size}`,
    brand: "brand",
    model: "trail_model",
    model_display: "",
    size,
    load_index: "102",
    speed_rating: "H",
    current_status: "active_retail",
    usable_for: "auto_count_candidate",
    source_count: 2,
  };
}

test("local demo countability uses the production identity gate", () => {
  assert.equal(isCountableLocalDemoRow(trustedRow("225/65R17")), true);
  assert.equal(isCountableLocalDemoRow(trustedRow("LT33X12.50R15")), true);
  assert.equal(isCountableLocalDemoRow(trustedRow("33125020")), false);
  assert.equal(isCountableLocalDemoRow(trustedRow("13/70R16")), false);
});
