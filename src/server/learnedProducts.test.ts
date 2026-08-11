// learnedProducts.ts (Task 21, owner-ratified 2026-07-15) - a prefix-corroborated learned-products
// tier. Mirrors decodeCacheStore.ts's file-fallback + Turso pattern (keyed upsert, not append-only).
// This file proves two things independently:
//   1. shouldLearnDecode - the PURE write gate (no storage, no network).
//   2. getLearnedProduct/upsertLearnedProduct - the storage roundtrip (file-fallback mode; no Turso
//      in CI, same convention as decodeCacheStore.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tursoMocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@libsql/client", () => ({
  createClient: (...args: unknown[]) => tursoMocks.createClient(...args),
}));

import {
  shouldLearnDecode,
  getLearnedProduct,
  upsertLearnedProduct,
  getLearnedProductsByPrefix,
  siblingPrefixConflict,
  __resetLearnedProductsForTest,
  type ShouldLearnInput,
  type LearnedProductRow,
} from "@/server/learnedProducts";

// --- shouldLearnDecode: pure gate ------------------------------------------------------------------

const walmartTireUrl = "https://www.walmart.com/ip/michelin-defender/12345";

function baseInput(overrides: Partial<ShouldLearnInput> = {}): ShouldLearnInput {
  return {
    code: "086699998538", // real Michelin-family GS1 prefix (086699), per brandFamilies.ts comment
    status: "verified",
    exactCodeEvidenceVerifiedByApp: true,
    evidenceStrength: "fetched_source",
    sourceUrl: walmartTireUrl,
    brand: "Michelin",
    category: "tire",
    productName: "Michelin Defender LTX M/S 275/60R20 115T",
    specsShort: "275/60R20 115T",
    specsFull: "275/60R20 115T",
    ...overrides,
  };
}

describe("shouldLearnDecode (Task 21 pure write gate)", () => {
  it("full pass: verified + app-verified + fetched_source + trusted host + prefix-corroborated tire with specs -> learn", () => {
    expect(shouldLearnDecode(baseInput())).toBe(true);
  });

  it("refuses when there is no prefix data at all (unknown prefix, cannot corroborate)", () => {
    expect(shouldLearnDecode(baseInput({ code: "999999999999", brand: "Michelin" }))).toBe(false);
  });

  it("refuses when the prefix's dominant/family brand does NOT match the decoded brand (mismatch)", () => {
    // 086699 is a Michelin-family prefix; a decode claiming an unrelated brand must never corroborate.
    expect(shouldLearnDecode(baseInput({ brand: "TotallyUnrelatedBrand" }))).toBe(false);
  });

  it("refuses on url_only strength even from a trusted host", () => {
    expect(shouldLearnDecode(baseInput({ evidenceStrength: "url_only" }))).toBe(false);
  });

  it("refuses on snippet strength even from a trusted host", () => {
    expect(shouldLearnDecode(baseInput({ evidenceStrength: "snippet" }))).toBe(false);
  });

  it("refuses when status is 'suggested' (not verified)", () => {
    expect(shouldLearnDecode(baseInput({ status: "suggested" }))).toBe(false);
  });

  it("refuses when exactCodeEvidenceVerifiedByApp is false (model self-claim only)", () => {
    expect(shouldLearnDecode(baseInput({ exactCodeEvidenceVerifiedByApp: false }))).toBe(false);
  });

  it("refuses when the source host is untrusted, even with full app-verified fetched_source evidence", () => {
    expect(shouldLearnDecode(baseInput({ sourceUrl: "https://randomblog.example.com/review" }))).toBe(false);
  });

  it("refuses a lookalike host (evil-walmart.com.attacker.io)", () => {
    expect(shouldLearnDecode(baseInput({ sourceUrl: "https://evil-walmart.com.attacker.io/x" }))).toBe(false);
  });

  it("refuses a tire decode missing required tire specs (size + load/speed)", () => {
    expect(shouldLearnDecode(baseInput({ category: "tire", specsShort: "", specsFull: "", productName: "Michelin Defender" }))).toBe(false);
  });

  it("refuses a sibling-size tire the same way a normal decode would (no specs = no countable identity)", () => {
    expect(shouldLearnDecode(baseInput({ category: "tire", productName: "Michelin Defender", specsShort: "", specsFull: "" }))).toBe(false);
  });

  it("a non-tire category with a trusted, verified, corroborated decode still learns (specs gate is tire-only)", () => {
    // Real single-brand GS1 prefix from brandPrefixMap.json ("2914284" -> "timberland") - a non-tire
    // brand, so this exercises brandPrefixGeneral's dominant-map corroboration path directly (not the
    // tire family table) and proves the tire specs gate does NOT apply outside the tire category.
    expect(
      shouldLearnDecode(
        baseInput({
          code: "029142840000",
          category: "footwear",
          brand: "Timberland",
          productName: "Timberland Pro Work Boot",
          specsShort: "",
          specsFull: "",
        }),
      ),
    ).toBe(true);
  });

  it("mere ABSENCE of a brand-prefix conflict is not corroboration - an unmapped prefix still refuses", () => {
    // A prefix with zero data cannot "positively corroborate" anything - shouldLearnDecode must not
    // treat silence as agreement.
    expect(shouldLearnDecode(baseInput({ code: "123456789012", brand: "Michelin" }))).toBe(false);
  });
});

// --- Storage: file-fallback mode (no Turso configured) ----------------------------------------------

describe("learnedProducts storage (file-fallback mode; no Turso configured)", () => {
  const keys = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "LEARNED_PRODUCTS_FILE"];
  const saved: Record<string, string | undefined> = {};
  let tmpFile: string;

  beforeEach(() => {
    __resetLearnedProductsForTest();
    tursoMocks.createClient.mockReset();
    for (const k of keys) saved[k] = process.env[k];
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    tmpFile = path.join(os.tmpdir(), `learned-products-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`);
    process.env.LEARNED_PRODUCTS_FILE = tmpFile;
  });

  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.unlinkSync(tmpFile); } catch { /* not created */ }
    __resetLearnedProductsForTest();
  });

  const row = (overrides: Partial<LearnedProductRow> = {}): LearnedProductRow => ({
    code: "086699998538",
    name: "Michelin Defender LTX M/S",
    brand: "Michelin",
    category: "tire",
    specsShort: "275/60R20 115T",
    specsFull: "275/60R20 115T",
    confidence: 0.95,
    sourceUrl: walmartTireUrl,
    evidenceStrength: "fetched_source",
    prefixCheck: "corroborated: michelin family (086699)",
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it("returns null for a code never learned", async () => {
    expect(await getLearnedProduct("000000000000")).toBeNull();
  });

  it("roundtrip: upserts a learned row and reads it back", async () => {
    await upsertLearnedProduct(row());
    const got = await getLearnedProduct("086699998538");
    expect(got).not.toBeNull();
    expect(got!.name).toBe("Michelin Defender LTX M/S");
    expect(got!.confidence).toBe(0.95);
  });

  it("INSERT OR REPLACE semantics: upserting the same code twice overwrites, never duplicates", async () => {
    await upsertLearnedProduct(row({ confidence: 0.95 }));
    await upsertLearnedProduct(row({ confidence: 0.97, name: "Michelin Defender LTX M/S (updated)" }));
    const got = await getLearnedProduct("086699998538");
    expect(got!.confidence).toBe(0.97);
    expect(got!.name).toContain("updated");
    const raw = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    // Stored under the canonical (14-digit, zero-padded) key - canonicalGtin always pads to 14.
    expect(Object.keys(raw)).toHaveLength(1);
  });

  it("canonical keying: a differently-padded GTIN of the same code reads/writes the same row", async () => {
    await upsertLearnedProduct(row({ code: "0086699998538" })); // GTIN-13 form (one extra leading zero)
    const got = await getLearnedProduct("086699998538"); // UPC-A (12-digit) form of the SAME code
    expect(got).not.toBeNull();
  });

  it("corrupted file is tolerated: returns null, never throws, and self-heals on next write", async () => {
    fs.writeFileSync(tmpFile, "{ not valid json ][");
    await expect(getLearnedProduct("086699998538")).resolves.toBeNull();
    await upsertLearnedProduct(row());
    const got = await getLearnedProduct("086699998538");
    expect(got).not.toBeNull();
  });

  it("never throws even when the write target is impossible (best-effort)", async () => {
    process.env.LEARNED_PRODUCTS_FILE = path.join(tmpFile, "nested", "impossible.json");
    await expect(upsertLearnedProduct(row())).resolves.toBeUndefined();
  });

  it("empty/blank code is a no-op for both read and write", async () => {
    expect(await getLearnedProduct("")).toBeNull();
    await expect(upsertLearnedProduct(row({ code: "  " }))).resolves.toBeUndefined();
  });

  // --- Item C4: same-prefix sibling contradiction guard --------------------------------------------
  // Owner-reported live regression (tonight's preview run): a code sharing the same GS1 company prefix
  // as an already-VERIFIED (learned) tire decoded to a completely unrelated random product (perfume)
  // and was stored as a clean suggestion instead of conflicting. Fixture: 721749* prefix family -
  // 721749089643 learned as "Fortune Tormenta H/T FSR305 265/75R16 116T BSW" (tire), a sibling code on
  // the SAME prefix (721749249238 in the live batch) must not silently store an unrelated identity like
  // "LATTAFA GIVE ME GOURMAND VANILLA FREAK/EDP" (perfume) without at least a demotion to review.
  describe("getLearnedProductsByPrefix: reverse prefix->learned-siblings lookup", () => {
    it("returns learned rows sharing the same 7-digit GS1 prefix", async () => {
      await upsertLearnedProduct(row({ code: "721749089643", brand: "Fortune", category: "tire", name: "Fortune Tormenta H/T FSR305 265/75R16 116T BSW" }));
      const siblings = await getLearnedProductsByPrefix("721749");
      expect(siblings.some((r) => r.code.includes("721749089643") || r.code.endsWith("21749089643"))).toBe(true);
    });

    it("returns an empty array when no learned row shares the prefix", async () => {
      expect(await getLearnedProductsByPrefix("9999999")).toEqual([]);
    });

    it("empty/blank prefix is a no-op", async () => {
      expect(await getLearnedProductsByPrefix("")).toEqual([]);
    });
  });

  describe("siblingPrefixConflict: brand+category contradiction against verified same-prefix siblings", () => {
    const fortuneTire = row({
      code: "721749089643",
      brand: "Fortune",
      category: "tire",
      name: "Fortune Tormenta H/T FSR305 265/75R16 116T BSW",
    });

    it("flags a conflict when a different brand AND different category is proposed on the same prefix (Lattafa perfume vs Fortune tire)", async () => {
      await upsertLearnedProduct(fortuneTire);
      const verdict = await siblingPrefixConflict("721749249238", { brand: "Lattafa", category: "perfume" });
      expect(verdict.conflict).toBe(true);
      expect(verdict.reason).toMatch(/fortune/i);
    });

    it("does NOT flag a same-company different-category product (legitimate multi-category manufacturer)", async () => {
      await upsertLearnedProduct(fortuneTire);
      const verdict = await siblingPrefixConflict("721749249238", { brand: "Fortune", category: "wheel accessory" });
      expect(verdict.conflict).toBe(false);
    });

    it("does NOT flag when strong app-verified exact-code evidence is present (override)", async () => {
      await upsertLearnedProduct(fortuneTire);
      const verdict = await siblingPrefixConflict("721749249238", { brand: "Lattafa", category: "perfume" }, { exactCodeVerifiedByApp: true });
      expect(verdict.conflict).toBe(false);
      expect(verdict.overriddenByEvidence).toBe(true);
    });

    it("is inert (no conflict) when there is no learned sibling on this prefix at all", async () => {
      const verdict = await siblingPrefixConflict("999999912345", { brand: "AnyBrand", category: "anything" });
      expect(verdict.conflict).toBe(false);
    });
  });

  it("never logs Turso URLs, tokens, driver messages, SQL, or row details on any failure path", async () => {
    const privateUrl = "libsql://private-learned.example.invalid/db";
    const privateToken = "learned-products-secret-token";
    const leakedDriverText = `${privateUrl} authToken=${privateToken} SQL SELECT secret-row LEAK_SENTINEL`;
    process.env.TURSO_DATABASE_URL = privateUrl;
    process.env.TURSO_AUTH_TOKEN = privateToken;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const assertRedacted = () => {
      const output = warn.mock.calls.flat().join(" ");
      expect(output).not.toContain(privateUrl);
      expect(output).not.toContain(privateToken);
      expect(output).not.toContain("LEAK_SENTINEL");
      expect(output).not.toContain("secret-row");
      warn.mockClear();
    };

    __resetLearnedProductsForTest();
    tursoMocks.createClient.mockImplementation(() => { throw new Error(leakedDriverText); });
    await getLearnedProduct("086699998538");
    assertRedacted();

    const failingClient = (failSql: RegExp) => ({
      execute: vi.fn(async ({ sql }: { sql: string }) => {
        if (failSql.test(sql)) throw new Error(leakedDriverText);
        return { rows: [] };
      }),
    });

    __resetLearnedProductsForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^CREATE /));
    await getLearnedProduct("086699998538");
    assertRedacted();

    __resetLearnedProductsForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^SELECT .*FROM learned_products WHERE code = /));
    await getLearnedProduct("086699998538");
    assertRedacted();

    __resetLearnedProductsForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^INSERT /));
    await upsertLearnedProduct(row());
    assertRedacted();

    __resetLearnedProductsForTest();
    tursoMocks.createClient.mockReset().mockReturnValue(failingClient(/^SELECT .*WHERE code LIKE /));
    await getLearnedProductsByPrefix("086699");
    assertRedacted();

    warn.mockRestore();
  });
});
