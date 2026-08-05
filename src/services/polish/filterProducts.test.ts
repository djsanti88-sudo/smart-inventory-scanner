import { describe, it, expect } from "vitest";
import { filterProducts, type FilterableRow } from "@/services/polish/filterProducts";

const rows: FilterableRow[] = [
  { id: "1", brand: "Cooper", model: "Discoverer AT3", description: "Cooper Discoverer AT3 205/55R16", sizeTag: "2055516" },
  { id: "2", brand: "Michelin", model: "Defender", description: "Michelin Defender 205/65R15", sizeTag: "2056515" },
  { id: "3", brand: "Falken", model: "Wildpeak", description: "Falken Wildpeak 225/45R17", sizeTag: "2254517" },
];

describe("filterProducts", () => {
  it("returns every row when the query is empty or whitespace", () => {
    expect(filterProducts(rows, "")).toEqual(rows);
    expect(filterProducts(rows, "   ")).toEqual(rows);
  });

  it("digits-only query filters by sizeTag EXACT prefix match", () => {
    expect(filterProducts(rows, "2055516").map((r) => r.id)).toEqual(["1"]);
  });

  it("digits-only shorter query filters by sizeTag PREFIX (multiple matches)", () => {
    expect(filterProducts(rows, "205").map((r) => r.id).sort()).toEqual(["1", "2"]);
  });

  it("digits-only query with no matching prefix returns no rows", () => {
    expect(filterProducts(rows, "999")).toEqual([]);
  });

  it("text query matches brand case-insensitively", () => {
    expect(filterProducts(rows, "cooper").map((r) => r.id)).toEqual(["1"]);
  });

  it("text query matches model case-insensitively", () => {
    expect(filterProducts(rows, "wildpeak").map((r) => r.id)).toEqual(["3"]);
  });

  it("text query matches description case-insensitively", () => {
    expect(filterProducts(rows, "MICHELIN DEFENDER").map((r) => r.id)).toEqual(["2"]);
  });

  it("text query with no match returns no rows", () => {
    expect(filterProducts(rows, "nonexistent")).toEqual([]);
  });
});

// W3 data-flows bot (taskD4) repro: a shop owner searching the EXACT size shown in the Size column
// (which includes a "/", e.g. "275/55R20") got zero results, even though the digits-only form of the
// same query ("2755520") worked. Root cause: any query with a non-digit character was routed only to
// brand/model/description text search, and description never carries the size. These fixtures
// deliberately do NOT repeat the size string inside description/brand/model, unlike the fixtures
// above, so a fix that only "happens" to match via incidental description text is caught.
const sizeRows: FilterableRow[] = [
  { id: "s1", brand: "Goodyear", model: "Wrangler", description: "Goodyear Wrangler All-Terrain", sizeTag: "2755520" },
  { id: "s2", brand: "Bridgestone", model: "Dueler", description: "Bridgestone Dueler H/T", sizeTag: "2657017" },
  { id: "s3", brand: "Continental", model: "TerrainContact", description: "Continental TerrainContact A/T", sizeTag: "2255517" },
];

describe("filterProducts - size query containing a slash (taskD4 regression)", () => {
  it("matches the exact size as displayed, including the slash (e.g. 275/55R20)", () => {
    expect(filterProducts(sizeRows, "275/55R20").map((r) => r.id)).toEqual(["s1"]);
  });

  it("matches a partial size containing a slash (e.g. 275/55)", () => {
    expect(filterProducts(sizeRows, "275/55").map((r) => r.id)).toEqual(["s1"]);
  });

  it("still matches the plain digits-only form of the same size", () => {
    expect(filterProducts(sizeRows, "2755520").map((r) => r.id)).toEqual(["s1"]);
  });

  it("still matches brand text search unaffected by the size fix", () => {
    expect(filterProducts(sizeRows, "Goodyear").map((r) => r.id)).toEqual(["s1"]);
  });

  it("still matches model text search case-insensitively unaffected by the size fix", () => {
    expect(filterProducts(sizeRows, "dueler").map((r) => r.id)).toEqual(["s2"]);
  });

  it("a slash-bearing query that matches no size and no text returns no rows, and never throws", () => {
    expect(() => filterProducts(sizeRows, "999/99R99")).not.toThrow();
    expect(filterProducts(sizeRows, "999/99R99")).toEqual([]);
  });

  it("a query built entirely from regex metacharacters never throws and matches nothing spuriously", () => {
    expect(() => filterProducts(sizeRows, "(.*)+")).not.toThrow();
    expect(() => filterProducts(sizeRows, "[a-z")).not.toThrow();
    expect(filterProducts(sizeRows, "(.*)+")).toEqual([]);
  });
});
