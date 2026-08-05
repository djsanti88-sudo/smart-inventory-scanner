import assert from "node:assert/strict";
import test from "node:test";
import { selectUiCorpusSample } from "./fixtures.mjs";
test("UI selection starts with the shortest source-derived spellings and adds boundaries", () => {
  const spellings = new Map(Array.from({ length: 25 }, (_, index) => [`${index}`.repeat(index % 3 + 3), { lookupKey: `nongtin:${index}`, canonicalProductId: `p-${index}` }]));
  const sample = selectUiCorpusSample({ spellings }, { shortest: 20, boundary: 2 });
  assert.equal(sample.length >= 20, true); assert.equal(sample.slice(0, 20).every((entry, index, values) => index === 0 || values[index - 1].code.length <= entry.code.length), true);
});
