import { describe, it, expect } from "vitest";
import { parse } from "csv-parse/sync";
import { validCheckDigit, classifyRow, missingRequiredColumns, normBarcode, normPart } from "./corpusRules.mjs";

describe("CSV parsing robustness (csv-parse, not naive split)", () => {
  it("keeps quoted commas + source snippets intact and preserves leading-zero barcodes as strings", () => {
    const csv = [
      "brand,model,barcode,source_url",
      'Cooper,"Discoverer A/T3, LT (10 Ply)",029142712886,"https://x.com/p?a=1,2"',
      'Falken,"Wildpeak ""A/T3W""",048983006165,',
    ].join("\n");
    const rows = parse(csv, { columns: true, skip_empty_lines: true });
    expect(rows[0].model).toBe("Discoverer A/T3, LT (10 Ply)"); // quoted comma not split
    expect(rows[0].source_url).toBe("https://x.com/p?a=1,2"); // comma inside quoted URL kept
    expect(rows[0].barcode).toBe("029142712886"); // string, leading zero intact
    expect(rows[1].model).toBe('Wildpeak "A/T3W"'); // escaped quotes
    expect(rows[1].source_url).toBe(""); // empty optional field
  });
});

// Generator trust rules: independently verify check digits, ingest ONLY trusted/current/usable rows,
// preserve leading zeros, and never near-match. These guard what reaches the server-only index.

const trustedRow = (over = {}) => ({
  brand: "Cooper", model: "Discoverer A/T3", size: "LT245/75R16", barcode: "029142712886", barcode_type: "upc_a",
  check_digit_valid: "yes", confidence: "verified_2src", current_status: "active_retail", usable_for: "auto_count_candidate",
  canonical_product_uid: "cooper-at3", ...over,
});

describe("corpusRules - check digit (independently verified, not trusted from the CSV)", () => {
  it("accepts real valid UPC-A barcodes", () => {
    expect(validCheckDigit("029142712886", "upc_a")).toBe(true); // Cooper
    expect(validCheckDigit("848983006165", "upc_a")).toBe(true); // Falken
    expect(validCheckDigit("086699205636", "upc_a")).toBe(true); // Michelin
  });
  it("rejects an invalid check digit even if the CSV claims check_digit_valid=yes", () => {
    expect(validCheckDigit("029142712880", "upc_a")).toBe(false); // wrong last digit
    expect(classifyRow(trustedRow({ barcode: "029142712880" })).ok).toBe(false);
  });
  it("rejects wrong-length / non-numeric barcodes", () => {
    expect(validCheckDigit("12345", "upc_a")).toBe(false);
    expect(validCheckDigit("X00ABC1234", "upc_a")).toBe(false);
  });
});

describe("corpusRules - near-match safety (poison)", () => {
  it("745125495781 and 7451254957818 are NEVER equated (different codes, exact-only)", () => {
    // Both happen to be valid for their own type; that is irrelevant - the index keys are EXACT, so a scan
    // of 745125495781 can never resolve a 7451254957818 row.
    expect(normBarcode("745125495781")).toBe("745125495781");
    expect(normBarcode("7451254957818")).toBe("7451254957818");
    expect(normBarcode("745125495781")).not.toBe(normBarcode("7451254957818"));
  });
});

describe("corpusRules - trusted row filter", () => {
  it("ingests a verified_2src active auto-count-candidate row", () => {
    expect(classifyRow(trustedRow()).ok).toBe(true);
  });
  it("REJECTS weak / context / non-current / non-usable tiers (never auto-count)", () => {
    expect(classifyRow(trustedRow({ confidence: "verified_1src_weak" })).reason).toBe("untrusted_confidence");
    expect(classifyRow(trustedRow({ confidence: "rag_context" })).reason).toBe("untrusted_confidence");
    expect(classifyRow(trustedRow({ confidence: "needs_enrichment" })).reason).toBe("untrusted_confidence");
    expect(classifyRow(trustedRow({ current_status: "discontinued" })).reason).toBe("not_current");
    expect(classifyRow(trustedRow({ usable_for: "rejected" })).reason).toBe("not_usable");
  });
  it("REJECTS rows missing identity or barcode", () => {
    expect(classifyRow(trustedRow({ model: "" })).reason).toBe("missing_identity");
    expect(classifyRow(trustedRow({ barcode: "" })).reason).toBe("missing_barcode");
  });
});

describe("corpusRules - schema + normalization", () => {
  it("flags a missing required column (generator then fails closed)", () => {
    const headers = ["brand", "model", "size", "barcode_type", "check_digit_valid", "confidence", "current_status", "usable_for", "canonical_product_uid"];
    expect(missingRequiredColumns(headers)).toEqual(["barcode"]);
    expect(missingRequiredColumns(["brand", "model", "size", "barcode", "barcode_type", "check_digit_valid", "confidence", "current_status", "usable_for", "canonical_product_uid"])).toEqual([]);
  });
  it("preserves leading zeros + strips separators (no numeric conversion)", () => {
    expect(normBarcode("0 29142-712886")).toBe("029142712886");
    expect(normBarcode("00012345")).toBe("00012345");
    expect(normPart(" 28033503 ")).toBe("28033503");
  });
});
