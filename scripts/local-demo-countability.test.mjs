import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  isCountableLocalDemoRow,
  reconstructLocalDemoProviderIdentity,
  resolvesKnownAgainstLocalDemoSeed,
} from "./local-demo-countability.ts";

const bossVerifiedRegression = JSON.parse(
  readFileSync(new URL("./fixtures/boss-verified-88.fixture.json", import.meta.url), "utf8"),
);

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

function seededCollisionRow() {
  return {
    ...trustedRow("215/70R15"),
    barcode: "848983012906",
    canonical_product_uid: "TIRE_COLLIDES_WITH_BUILT_IN_SEED",
  };
}

function rowWithBarcode(barcode) {
  return {
    ...trustedRow("215/70R15"),
    barcode,
    canonical_product_uid: `TIRE_${barcode}`,
  };
}

test("local demo countability uses the production identity gate", () => {
  assert.equal(isCountableLocalDemoRow(trustedRow("225/65R17")), true);
  assert.equal(isCountableLocalDemoRow(trustedRow("LT33X12.50R15")), true);
  assert.equal(isCountableLocalDemoRow(trustedRow("33125020")), false);
  assert.equal(isCountableLocalDemoRow(trustedRow("13/70R16")), false);
});

test("local demo countability excludes only known built-in seed resolutions before the tire corpus", () => {
  assert.equal(resolvesKnownAgainstLocalDemoSeed(seededCollisionRow()), true);
  assert.equal(isCountableLocalDemoRow(seededCollisionRow()), false);
  assert.equal(resolvesKnownAgainstLocalDemoSeed(rowWithBarcode("0848983012906")), true);
  assert.equal(isCountableLocalDemoRow(rowWithBarcode("0848983012906")), false);
  assert.equal(resolvesKnownAgainstLocalDemoSeed(rowWithBarcode("6419440485331")), true);
  assert.equal(isCountableLocalDemoRow(rowWithBarcode("6419440485331")), false);
  assert.equal(isCountableLocalDemoRow(trustedRow("215/70R15")), true);
});

test("a synthetic built-in seed conflict remains a countable corpus candidate", () => {
  const row = trustedRow("215/70R15");
  const conflictSeed = {
    products: [
      { id: "seed-a", businessId: "demo-business", name: "Seed A", verified: true, primaryBarcode: row.barcode, primarySku: "", gtin: "", upc: "", ean: "", vendorCodes: [] },
      { id: "seed-b", businessId: "demo-business", name: "Seed B", verified: true, primaryBarcode: "", primarySku: "", gtin: row.barcode, upc: "", ean: "", vendorCodes: [] },
    ],
    aliases: [],
  };
  assert.equal(resolvesKnownAgainstLocalDemoSeed(row, conflictSeed), false);
  assert.equal(isCountableLocalDemoRow(row, conflictSeed), true);
});

test("provider display identity uses the deterministic normalized size and preserves an unsupported raw size", () => {
  assert.equal(reconstructLocalDemoProviderIdentity(trustedRow("2856020")).displaySize, "285/60R20");
  assert.equal(reconstructLocalDemoProviderIdentity(trustedRow("LT33/12.50R15")).displaySize, "LT33X12.50R15");
  assert.equal(reconstructLocalDemoProviderIdentity(trustedRow("2356017")).displaySize, "235/60R17");
  assert.equal(reconstructLocalDemoProviderIdentity(trustedRow("13/70R16")).displaySize, "13/70R16");
});

test("provider display identity reuses the trusted-corpus projector for Boss compact forms", () => {
  assert.equal(
    reconstructLocalDemoProviderIdentity({ ...trustedRow("35125020"), model: "trail_model", model_display: "35x12 50r20lt Trail model" }).displaySize,
    "35X12.50R20",
  );
  assert.equal(reconstructLocalDemoProviderIdentity(trustedRow("29575225")).displaySize, "295/75R22.5");
  assert.equal(reconstructLocalDemoProviderIdentity(trustedRow("35125020")).displaySize, "35125020");
});

test("all formerly verified-but-not-countable Boss rows now project a countable identity", () => {
  assert.equal(bossVerifiedRegression.length, 88);
  assert.equal(new Set(bossVerifiedRegression.map((row) => row.barcode)).size, 88);
  for (const row of bossVerifiedRegression) {
    assert.equal(reconstructLocalDemoProviderIdentity(row).displaySize, row.expected, row.barcode);
    assert.equal(isCountableLocalDemoRow({ ...trustedRow(row.size), ...row }), true, row.barcode);
  }
});
