// DT harvest Task 6 Step 2 - integration proof (production rung-1 path).
//
// The decode route's FIRST rung for a tire barcode is resolveExactBarcode() (see
// src/app/api/ai-lookup/route.ts). This test drives 10 Discount-Tire GTINs that the
// apply step reported as NEWLY added to the corpus through that exact production
// function and asserts each resolves "verified" via corpus_exact_barcode with NO AI
// and the correct brand - i.e. the harvested rows are live in the free rung, so these
// codes cost $0 in production. Runs against the rebuilt knowledge.generated.db.
import { describe, it, expect } from "vitest";
import { resolveExactBarcode } from "./TireKnowledgeProvider";

// 10 newly-added DT GTINs (from the apply spot-check sample) + their expected brand.
const NEW_DT_CODES: Array<{ code: string; brand: string }> = [
  { code: "092971223670", brand: "bridgestone" },
  { code: "086699385932", brand: "michelin" },
  { code: "721506740220", brand: "yokohama" },
  { code: "848983008237", brand: "falken" },
  { code: "6419440288420", brand: "nokian" },
  { code: "715459479207", brand: "hankook" },
  { code: "758823001796", brand: "milestar" },
  { code: "6932877105172", brand: "gt radial" },
  { code: "6953913130491", brand: "atturo" },
  { code: "054137093626", brand: "pirelli" },
];

describe("DT harvest integration - newly-added GTINs resolve at the free corpus rung", () => {
  for (const { code, brand } of NEW_DT_CODES) {
    it(`${code} resolves verified via corpus_exact_barcode (no AI), brand ${brand}`, async () => {
      const result = await resolveExactBarcode(code);
      expect(result, `${code} should resolve from the corpus`).not.toBeNull();
      expect(result!.decision.status).toBe("verified");
      expect(result!.decision.corroborationPath).toBe("corpus_exact_barcode");
      expect(result!.decision.exactCodeEvidenceVerifiedByApp).toBe(true);
      // brand comes back on the first result identity; compare case-insensitively.
      const gotBrand = (result!.results?.[0]?.brand ?? "").toLowerCase();
      expect(gotBrand).toBe(brand);
    });
  }
});
