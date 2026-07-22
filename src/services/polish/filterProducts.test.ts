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
