import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOSS_SHOP_CODE_REDIRECTS, type BossShopCodeRedirect } from "@/server/tire-knowledge/bossExactEvidenceLedger";

const mocks = vi.hoisted(() => ({
  getKnowledgeDb: vi.fn(),
  getTursoClient: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("@/server/knowledgeDb", () => ({
  getKnowledgeDb: () => mocks.getKnowledgeDb(),
  __resetKnowledgeDbForTests: () => {},
}));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  getTursoClient: () => mocks.getTursoClient(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: (...args: Parameters<typeof mocks.readFileSync>) => mocks.readFileSync(...args),
}));

import {
  __resetTireKnowledgeCacheForTests,
  lookupByExactBarcode,
  type TireKnowledgeRow,
} from "@/server/tire-knowledge/tireKnowledgeIndex";

function targetRow(redirect: BossShopCodeRedirect): TireKnowledgeRow {
  return {
    canonical_product_uid: redirect.canonicalProductUid,
    brand: redirect.normalizedBrand,
    brand_normalized: redirect.normalizedBrand,
    model: "approved model",
    model_normalized: "approved model",
    size: redirect.canonicalSize,
    raw_size_text: redirect.canonicalSize,
    load_index: "", speed_rating: "", load_range: "", type: "", season: "",
    manufacturer_part_number: redirect.canonicalManufacturerPartNumber,
    barcode: redirect.canonicalBarcode, barcode_type: "ean",
    confidence: "verified_2src", current_status: "active", usable_for: "sale",
    field_completeness_score: "1", missing_fields: "", source_count: 2,
  };
}

function fakeTurso(rowsByBarcode: Record<string, TireKnowledgeRow>, options: { throw?: boolean } = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    calls,
    async execute({ sql, args }: { sql: string; args: unknown[] }) {
      calls.push({ sql, args });
      if (options.throw) throw new Error("simulated backend failure");
      if (sql === "SELECT * FROM tires WHERE barcode = ?") {
        const row = rowsByBarcode[args[0] as string];
        return { rows: row ? [row] : [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetTireKnowledgeCacheForTests();
  process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = "tenant-a";
});

describe("approved Boss shop-code aliases", () => {
  it("resolves 3220017209 through SQLite only after the ordinary exact candidates miss", async () => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    const canonical = targetRow(redirect);
    const get = vi.fn((barcode: string) => barcode === redirect.canonicalBarcode ? canonical : undefined);
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });

    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId: "tenant-a" })).resolves.toMatchObject({
      barcode: redirect.canonicalBarcode,
      canonical_product_uid: redirect.canonicalProductUid,
      bossShopCodeAliasSelected: "3220017209",
    });
    expect(get).toHaveBeenLastCalledWith(redirect.canonicalBarcode);
  });

  it("resolves every frozen redirect through the exact Turso barcode query", async () => {
    mocks.getKnowledgeDb.mockReturnValue(null);
    const rows = Object.fromEntries(BOSS_SHOP_CODE_REDIRECTS.map((redirect) => [redirect.canonicalBarcode, targetRow(redirect)]));
    const client = fakeTurso(rows);
    mocks.getTursoClient.mockResolvedValue(client);

    for (const redirect of BOSS_SHOP_CODE_REDIRECTS) {
      __resetTireKnowledgeCacheForTests();
      const row = await lookupByExactBarcode(redirect.scannedCode, { authenticatedBusinessId: "tenant-a" });
      expect(row).toMatchObject({
        barcode: redirect.canonicalBarcode,
        canonical_product_uid: redirect.canonicalProductUid,
        bossShopCodeAliasSelected: redirect.scannedCode,
      });
    }
    expect(client.calls.filter((call) => call.sql === "SELECT * FROM tires WHERE barcode = ?").some(
      (call) => call.args[0] === BOSS_SHOP_CODE_REDIRECTS[0].canonicalBarcode,
    )).toBe(true);
  });

  it("resolves 3220017209 through forced JSON fallback", async () => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    mocks.getKnowledgeDb.mockReturnValue(null);
    mocks.getTursoClient.mockResolvedValue(null);
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      barcodeIndex: { [redirect.canonicalBarcode]: targetRow(redirect) },
      partNumberIndex: {},
    }));

    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId: "tenant-a" })).resolves.toMatchObject({
      barcode: redirect.canonicalBarcode,
      bossShopCodeAliasSelected: "3220017209",
    });
  });

  it("returns an ordinary exact barcode before attempting a redirect", async () => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    const ordinary = { ...targetRow(redirect), barcode: redirect.scannedCode, canonical_product_uid: "ordinary-exact" };
    const get = vi.fn((barcode: string) => barcode === redirect.scannedCode ? ordinary : undefined);
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });

    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId: "tenant-a" })).resolves.toEqual(ordinary);
    expect(get).not.toHaveBeenCalledWith(redirect.canonicalBarcode);
  });

  it.each([
    ["unapproved shop code", "3220017210", {}],
    ["suffix near match", "32200172090", {}],
    ["prefix near match", "03220017209", {}],
    ["canonical target missing", "3220017209", {}],
    ["uid fingerprint mismatch", "3220017209", { canonical_product_uid: "wrong" }],
    ["part-number fingerprint mismatch", "3220017209", { manufacturer_part_number: "wrong" }],
    ["brand fingerprint mismatch", "3220017209", { brand: "wrong" }],
    ["size fingerprint mismatch", "3220017209", { size: "255/50R20", raw_size_text: "255/50R20" }],
  ])("fails closed for %s", async (_name, scannedCode, mutation) => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    mocks.getKnowledgeDb.mockReturnValue(null);
    const canonical = Object.keys(mutation).length === 0 ? undefined : { ...targetRow(redirect), ...mutation };
    mocks.getTursoClient.mockResolvedValue(fakeTurso(canonical ? { [redirect.canonicalBarcode]: canonical } : {}));

    await expect(lookupByExactBarcode(scannedCode, { authenticatedBusinessId: "tenant-a" })).resolves.toBeNull();
  });

  it("does not fall through from an available SQLite target miss to Turso or JSON", async () => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    const get = vi.fn(() => undefined);
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get })) });
    mocks.getTursoClient.mockResolvedValue(fakeTurso({ [redirect.canonicalBarcode]: targetRow(redirect) }));
    mocks.readFileSync.mockReturnValue(JSON.stringify({ barcodeIndex: {} }));

    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId: "tenant-a" })).resolves.toBeNull();
    expect(mocks.getTursoClient).not.toHaveBeenCalled();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it("fails closed when the Turso backend errors during redirect lookup", async () => {
    mocks.getKnowledgeDb.mockReturnValue(null);
    mocks.getTursoClient.mockResolvedValue(fakeTurso({}, { throw: true }));
    mocks.readFileSync.mockReturnValue(JSON.stringify({ barcodeIndex: {} }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId: "tenant-a" })).resolves.toBeNull();
    warn.mockRestore();
  });

  it("does not attempt a canonical redirect after an ordinary Turso candidate query errors", async () => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    mocks.getKnowledgeDb.mockReturnValue(null);
    const calls: string[] = [];
    mocks.getTursoClient.mockResolvedValue({
      async execute({ args }: { args: unknown[] }) {
        const barcode = args[0] as string;
        calls.push(barcode);
        if (barcode === "3220017209") throw new Error("ordinary probe uncertain");
        if (barcode === redirect.canonicalBarcode) return { rows: [targetRow(redirect)] };
        return { rows: [] };
      },
    });
    mocks.readFileSync.mockReturnValue(JSON.stringify({ barcodeIndex: { [redirect.canonicalBarcode]: targetRow(redirect) } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId: "tenant-a" })).resolves.toBeNull();
    expect(calls).not.toContain(redirect.canonicalBarcode);
    warn.mockRestore();
  });

  it.each([
    ["empty allowlist", "", "tenant-a"],
    ["anonymous scope", "tenant-a", undefined],
    ["unlisted tenant", "tenant-a", "tenant-b"],
  ])("does not enable a redirect for %s", async (_name, allowlist, authenticatedBusinessId) => {
    const redirect = BOSS_SHOP_CODE_REDIRECTS[0];
    process.env.BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS = allowlist;
    mocks.getKnowledgeDb.mockReturnValue({ prepare: vi.fn(() => ({ get: vi.fn((barcode: string) => barcode === redirect.canonicalBarcode ? targetRow(redirect) : undefined) })) });
    await expect(lookupByExactBarcode("3220017209", { authenticatedBusinessId })).resolves.toBeNull();
  });
});
