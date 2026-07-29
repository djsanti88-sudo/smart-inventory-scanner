// Task C1 - model display styling cleaner tests.
//
// Tests target `styleModel(brand, slug, rules)` as a pure function exported from
// 06_model_styling.mjs. No DB access in this file - the DB-writing behavior is proven
// separately by running the script itself and inspecting the audit table (see the C1 report).

import test from "node:test";
import assert from "node:assert/strict";
import { styleModel, buildRuleIndex } from "./06_model_styling.mjs";
import rulesData from "./model_styling_rules.json" with { type: "json" };

const ruleIndex = buildRuleIndex(rulesData.rules);

test("curated rule: falken wildpeak_a_t3w -> Wildpeak A/T3W", () => {
  const result = styleModel("falken", "wildpeak_a_t3w", ruleIndex);
  assert.equal(result.display, "Wildpeak A/T3W");
  assert.equal(result.ruleId, "falken_wildpeak_a_t3w");
  assert.equal(result.trustColor, "green");
});

test("curated rule: falken wildpeak_h_t02 -> Wildpeak H/T02", () => {
  const result = styleModel("falken", "wildpeak_h_t02", ruleIndex);
  assert.equal(result.display, "Wildpeak H/T02");
  assert.equal(result.ruleId, "falken_wildpeak_h_t02");
  assert.equal(result.trustColor, "green");
});

test("curated rule: toyo open_country_a_t_iii -> Open Country A/T III", () => {
  const result = styleModel("toyo", "open_country_a_t_iii", ruleIndex);
  assert.equal(result.display, "Open Country A/T III");
  assert.equal(result.ruleId, "toyo_open_country_a_t_iii");
  assert.equal(result.trustColor, "green");
});

test("curated rule lookup is case-insensitive on brand", () => {
  const result = styleModel("FALKEN", "wildpeak_a_t3w", ruleIndex);
  assert.equal(result.display, "Wildpeak A/T3W");
  assert.equal(result.ruleId, "falken_wildpeak_a_t3w");
});

test("fallback: unknown slug with no rule uppercases short alnum tokens, title-cases the rest", () => {
  // "roadian_gtx" has no curated rule under brand "unknownbrand" -> fallback path.
  // "roadian" -> title case "Roadian"; "gtx" matches ^[a-z]{2,4}[0-9]*$ -> "GTX".
  const result = styleModel("unknownbrand", "roadian_gtx", ruleIndex);
  assert.equal(result.display, "Roadian GTX");
  assert.equal(result.ruleId, null);
  assert.equal(result.trustColor, "yellow");
});

test("fallback: nfera_su1 without a rule falls back to Nfera SU1 (no apostrophe invented)", () => {
  // Without the curated nexen_nfera_su1 rule, the deterministic fallback must NOT invent the
  // brand apostrophe styling (N'Fera) since that is not information present in the slug -
  // styling reformats an existing value, it never adds information.
  const result = styleModel("unknownbrand", "nfera_su1", ruleIndex);
  assert.equal(result.display, "Nfera SU1");
  assert.equal(result.ruleId, null);
  assert.equal(result.trustColor, "yellow");
});

test("curated rule wins over fallback when both brand and slug match", () => {
  // nexen + nfera_su1 DOES have a curated rule (N'Fera SU1) - curated must take priority.
  const result = styleModel("nexen", "nfera_su1", ruleIndex);
  assert.equal(result.display, "N'Fera SU1");
  assert.equal(result.ruleId, "nexen_nfera_su1");
  assert.equal(result.trustColor, "green");
});

test("fallback: purely alphabetic multi-token slug title-cases each token", () => {
  const result = styleModel("unknownbrand", "grand_touring", ruleIndex);
  assert.equal(result.display, "Grand Touring");
  assert.equal(result.ruleId, null);
  assert.equal(result.trustColor, "yellow");
});

test("fallback: single long token (5+ letters, no digits) stays title case, not uppercased", () => {
  const result = styleModel("unknownbrand", "aklimate", ruleIndex);
  assert.equal(result.display, "Aklimate");
  assert.equal(result.ruleId, null);
  assert.equal(result.trustColor, "yellow");
});

test("fallback: numeric-only token stays as-is (no letters to case)", () => {
  const result = styleModel("unknownbrand", "solus_5", ruleIndex);
  assert.equal(result.display, "Solus 5");
  assert.equal(result.ruleId, null);
  assert.equal(result.trustColor, "yellow");
});

test("blank-safe: empty or null slug returns null display, no crash", () => {
  assert.equal(styleModel("falken", "", ruleIndex).display, null);
  assert.equal(styleModel("falken", null, ruleIndex).display, null);
  assert.equal(styleModel(null, "wildpeak_a_t3w", ruleIndex).ruleId, null);
});

test("every rule in model_styling_rules.json has rule_id, brand, slug, display, and source", () => {
  assert.ok(Array.isArray(rulesData.rules));
  assert.ok(rulesData.rules.length >= 90, "expect curated coverage for top ~100 models");
  for (const rule of rulesData.rules) {
    assert.equal(typeof rule.rule_id, "string");
    assert.ok(rule.rule_id.length > 0);
    assert.equal(typeof rule.brand, "string");
    assert.equal(typeof rule.slug, "string");
    assert.equal(typeof rule.display, "string");
    assert.equal(typeof rule.source, "string");
    assert.ok(rule.source.length > 0);
  }
});

test("no duplicate (brand, slug) pairs in the rules file", () => {
  const seen = new Set();
  for (const rule of rulesData.rules) {
    const key = `${rule.brand.toLowerCase()}::${rule.slug.toLowerCase()}`;
    assert.ok(!seen.has(key), `duplicate rule for ${key}`);
    seen.add(key);
  }
});
