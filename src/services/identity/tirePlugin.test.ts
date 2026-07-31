import { describe, expect, it } from "vitest";
import { tireIdentityPlugin } from "./tirePlugin";
import type { IdentityCandidate, IdentityInput } from "./types";

const input = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  businessId: "business-1",
  sourceSystem: "shop-ware",
  sourceSignature: "schema-v1",
  vendorId: "vendor-a",
  sourceFileFingerprint: "file-1",
  sourceFileOrdinal: 0,
  sheetName: "Inventory",
  sourceRowNumber: 2,
  identifiers: [],
  brand: "Michelin",
  title: "Michelin Defender LTX M/S 225/65R17 102H",
  attributes: { loadSpeed: "102H" },
  quantity: 1,
  rawRecordFingerprint: "row-1",
  ...overrides,
});

const candidate = (overrides: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  productId: "product-1",
  category: "tire",
  businessScope: "master",
  verificationTier: "human_verified",
  automaticEligible: true,
  evidenceId: "catalog-1",
  evidenceVersion: "v1",
  exactCodeEvidence: true,
  identifiers: [],
  brand: "Michelin",
  title: "Michelin Defender LTX M/S 225/65R17 102H",
  attributes: { loadSpeed: "102H" },
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-1",
  ...overrides,
});

describe("tireIdentityPlugin", () => {
  it("rejects a mismatched tire size despite otherwise similar text", () => {
    expect(tireIdentityPlugin.hardConstraints(input(), candidate({ title: "Michelin Defender LTX M/S 235/65R17 102H" }))).toEqual({
      outcome: "reject",
      contradictions: ["tire_size_mismatch:225/65R17!=235/65R17"],
      missing: [],
    });
  });

  it("rejects R8 versus R8+ as different tire generations", () => {
    expect(
      tireIdentityPlugin.hardConstraints(
        input({ brand: "Landsail", title: "Landsail LS588 R8 225/45R18 95W" }),
        candidate({ brand: "Landsail", title: "Landsail LS588 R8+ 225/45R18 95W" }),
      ),
    ).toEqual({ outcome: "reject", contradictions: ["tire_generation_mismatch"], missing: [] });
  });

  it("accepts curated same-family brands and treats absent fields as neutral", () => {
    expect(
      tireIdentityPlugin.hardConstraints(
        input({ brand: "Michelin", title: "Defender 225/65R17", attributes: {} }),
        candidate({ brand: "BFGoodrich", title: "Defender 225/65R17", attributes: {} }),
      ),
    ).toEqual({ outcome: "pass", corroborated: ["tire_size:225/65R17", "brand_family"], missing: ["load_speed"] });
  });

  it("rejects distinct nonblank load speed values", () => {
    expect(tireIdentityPlugin.hardConstraints(input(), candidate({ attributes: { loadSpeed: "105V" } }))).toEqual({
      outcome: "reject",
      contradictions: ["load_speed_mismatch:102H!=105V"],
      missing: [],
    });
  });
});
