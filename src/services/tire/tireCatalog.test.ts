import { describe, it, expect } from "vitest";
import {
  buildTireCatalog,
  dedupeKey,
  toImportCsv,
  toCatalogCsv,
  type TireObservation,
} from "./tireCatalog";

const obs = (o: Partial<TireObservation> & Pick<TireObservation, "sourceType" | "brand" | "model">): TireObservation => ({
  size: "245/40R18",
  ...o,
});

describe("tire dedupe key", () => {
  it("uses GTIN (digits only) when present", () => {
    expect(dedupeKey({ upcGtin: "0 4019238847352", brand: "Michelin", model: "PS4" })).toBe("gtin:04019238847352");
  });
  it("falls back to normalized identity tuple when no GTIN", () => {
    expect(dedupeKey({ brand: "Michelin", model: "Pilot Sport 4", size: "245/40R18", loadIndex: "97", speedRating: "Y" })).toBe(
      "id:michelin|pilot sport 4|245/40r18|97|y|",
    );
  });
});

describe("tire scoring + status (owner rules)", () => {
  it("single manufacturer source -> verified (base 0.8)", () => {
    const { records } = buildTireCatalog([obs({ sourceType: "manufacturer_catalog", brand: "Michelin", model: "Pilot Sport 4", upcGtin: "4019238847352" })]);
    expect(records).toHaveLength(1);
    expect(records[0].confidence).toBe(0.8);
    expect(records[0].status).toBe("verified");
    expect(records[0].scannable).toBe("verified_scannable"); // verified + has GTIN
  });

  it("single retailer source -> hold (base 0.4 < 0.5)", () => {
    const { records } = buildTireCatalog([obs({ sourceType: "retailer_page", brand: "Toyo", model: "Open Country" })]);
    expect(records[0].confidence).toBe(0.4);
    expect(records[0].status).toBe("hold");
  });

  it("two independent agreeing sources add +0.1 (distributor 0.6 + retailer -> 0.7 candidate)", () => {
    const { records } = buildTireCatalog([
      obs({ sourceType: "distributor_catalog", brand: "Falken", model: "Sincera ST80", vendorSku: "28816861" }),
      obs({ sourceType: "retailer_page", brand: "Falken", model: "Sincera ST80" }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].confidence).toBe(0.7);
    expect(records[0].status).toBe("candidate");
    expect(records[0].scannable).toBe("candidate_scannable"); // has a vendor SKU but not verified+GTIN
  });

  it("field confirmation adds +0.1", () => {
    const { records } = buildTireCatalog([obs({ sourceType: "distributor_catalog", brand: "Nitto", model: "NT555", fieldConfirmed: true })]);
    expect(records[0].confidence).toBe(0.7); // 0.6 + 0.1 field
  });

  it("conflict (same GTIN, different brand/model) -> -0.3 and conflicted", () => {
    const { records, conflicts } = buildTireCatalog([
      obs({ sourceType: "manufacturer_catalog", brand: "Michelin", model: "Pilot Sport 4", upcGtin: "4019238847352" }),
      obs({ sourceType: "manufacturer_catalog", brand: "Goodyear", model: "Eagle F1", upcGtin: "4019238847352" }),
    ]);
    expect(records).toHaveLength(1); // same GTIN -> one group
    expect(records[0].status).toBe("conflicted");
    expect(records[0].confidence).toBe(0.5); // 0.8 - 0.3
    expect(conflicts).toHaveLength(1);
  });
});

describe("scannable classification + no-padding counts", () => {
  const { records, counts } = buildTireCatalog([
    // verified scannable: manufacturer + GTIN
    obs({ sourceType: "manufacturer_catalog", brand: "Michelin", model: "Pilot Sport 4", upcGtin: "4019238847352" }),
    // candidate scannable: distributor + SKU, single source -> 0.6 candidate, has a code
    obs({ sourceType: "distributor_catalog", brand: "Falken", model: "Sincera ST80", vendorSku: "28816861" }),
    // spec-only candidate: distributor, no code at all -> 0.6 candidate, no scannable code
    obs({ sourceType: "distributor_catalog", brand: "Toyo", model: "Open Country AT3", size: "265/70R17" }),
    // hold (rejected/held): retailer single -> 0.4
    obs({ sourceType: "retailer_page", brand: "Generic", model: "Mystery", size: "205/55R16" }),
    // conflicted
    obs({ sourceType: "manufacturer_catalog", brand: "Nitto", model: "NT555", upcGtin: "111" }),
    obs({ sourceType: "manufacturer_catalog", brand: "Nexen", model: "NFera", upcGtin: "111" }),
  ]);

  it("classifies each record into exactly one category with no padding", () => {
    expect(counts.verifiedScannable).toBe(1);
    expect(counts.candidateScannable).toBe(1);
    expect(counts.specOnlyCandidate).toBe(1);
    expect(counts.rejectedHeld).toBe(1);
    expect(counts.conflicted).toBe(1);
    // categories partition all records
    expect(counts.verifiedScannable + counts.candidateScannable + counts.specOnlyCandidate + counts.rejectedHeld + counts.conflicted).toBe(counts.total);
  });

  it("a spec-only record is NEVER counted as verified scannable", () => {
    const specOnly = records.find((r) => r.brand === "Toyo");
    expect(specOnly?.scannable).toBe("spec_only");
  });

  it("import CSV emits only non-conflicted records that carry a scannable code", () => {
    const csv = toImportCsv(records);
    const lines = csv.trim().split("\n");
    // header + Michelin (GTIN) + Falken (SKU) = 3 lines; Toyo (spec-only), Generic (hold has no code), conflicted excluded
    expect(lines[0]).toContain("name,brand,category");
    expect(csv).toContain("Michelin Pilot Sport 4");
    expect(csv).toContain("Falken Sincera ST80");
    expect(csv).not.toContain("Toyo Open Country AT3"); // spec-only, no code
    expect(csv).not.toContain("Nitto"); // conflicted excluded
  });

  it("catalog CSV includes every record with provenance", () => {
    const csv = toCatalogCsv(records);
    expect(csv).toContain("Toyo");
    expect(csv).toContain("source_urls");
  });
});
