import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_LANES, previewLaneFixtures } from "./fixtures.mjs";

test("Preview topology uses twenty canonical-affine lanes under one thousand spellings each", () => {
  assert.equal(PREVIEW_LANES, 20);
  const lanes = Array.from({ length: PREVIEW_LANES }, (_, lane) => previewLaneFixtures(lane));
  assert.equal(lanes.reduce((total, fixture) => total + fixture.uiSpellings.length, 0), 13_346);
  assert.equal(lanes.reduce((total, fixture) => total + fixture.groups.length, 0), 5_316);
  assert.equal(lanes.every((fixture) => fixture.uiSpellings.length <= 1_000), true);
  const ownerByCanonical = new Map();
  lanes.forEach((fixture, lane) => fixture.groups.forEach((group) => {
    assert.equal(ownerByCanonical.has(group.canonicalKey), false, `canonical group split: ${group.canonicalKey}`);
    ownerByCanonical.set(group.canonicalKey, lane);
  }));
  assert.equal(ownerByCanonical.size, 5_316);
});
