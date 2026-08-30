import type { Alias, Product } from "@/types";
import { buildNormalizedCandidates, cleanScanCode } from "@/scanning/clean/scanCleaner";

// Deterministic seed data for local proof. Spans multiple trades (tires, beverage, supplement,
// tool) to prove the app is not tied to one industry. Fixed ids/timestamps keep tests stable.

export const DEMO_BUSINESS_ID = "demo-business";
const SEED_AT = "2026-01-01T00:00:00.000Z";

interface SeedSpec {
  id: string;
  name: string;
  brand: string;
  category: string;
  specsShort: string;
  primarySku: string;
  primaryBarcode: string;
  gtin: string;
  upc: string;
  ean: string;
  imageUrl: string;
  location: string;
  aliasRawCodes: string[]; // raw scannable codes that all point to this product
}

const SPECS: SeedSpec[] = [
  {
    id: "prod-nokian",
    name: "Nokian Outpost APT",
    brand: "Nokian",
    category: "Tire",
    specsShort: "245/55R19 103H",
    primarySku: "T432119",
    primaryBarcode: "6419440485331",
    gtin: "6419440485331",
    upc: "",
    ean: "",
    imageUrl: "https://images.example.com/nokian-outpost-apt.jpg",
    location: "Bay A",
    aliasRawCodes: ["6419440485331", "T432119", "T432119%RU1%"],
  },
  {
    id: "prod-falken",
    name: "Falken Sincera ST80 A/S",
    brand: "Falken",
    category: "Tire",
    specsShort: "215/70R15 98T",
    primarySku: "28816861",
    primaryBarcode: "848983012906",
    gtin: "848983012906",
    upc: "",
    ean: "",
    imageUrl: "https://images.example.com/falken-sincera-st80.jpg",
    location: "Bay B",
    aliasRawCodes: ["848983012906", "28816861", "2881-6861"],
  },
  {
    id: "prod-coke",
    name: "Coca-Cola 12 pack 12 oz cans",
    brand: "Coca-Cola",
    category: "Beverage",
    specsShort: "12 x 12 oz",
    primarySku: "",
    primaryBarcode: "049000028904",
    gtin: "",
    upc: "049000028904",
    ean: "",
    imageUrl: "https://images.example.com/coca-cola-12pack.jpg",
    location: "Cooler 1",
    aliasRawCodes: ["049000028904", "7262"],
  },
  {
    id: "prod-supplement",
    name: "Vital Whey Protein Vanilla 2lb",
    brand: "VitalNutrition",
    category: "Supplement",
    specsShort: "2 lb, vanilla",
    primarySku: "VWP-VAN-2LB",
    primaryBarcode: "850012345678",
    gtin: "",
    upc: "850012345678",
    ean: "",
    imageUrl: "https://images.example.com/vital-whey-vanilla.jpg",
    location: "Shelf C3",
    aliasRawCodes: ["850012345678", "VWP-VAN-2LB"],
  },
  {
    id: "prod-tool",
    name: "DeWalt 20V Impact Driver",
    brand: "DeWalt",
    category: "Tool",
    specsShort: "20V MAX, bare tool",
    primarySku: "DCF887B",
    primaryBarcode: "885911484047",
    gtin: "00885911484047",
    upc: "885911484047",
    ean: "",
    imageUrl: "https://images.example.com/dewalt-dcf887b.jpg",
    location: "Cage 2",
    aliasRawCodes: ["885911484047", "DCF887B"],
  },
];

function buildProduct(spec: SeedSpec): Product {
  return {
    id: spec.id,
    businessId: DEMO_BUSINESS_ID,
    name: spec.name,
    brand: spec.brand,
    category: spec.category,
    specsShort: spec.specsShort,
    specsFull: `${spec.brand} ${spec.name} ${spec.specsShort}`.trim(),
    primarySku: spec.primarySku,
    primaryBarcode: spec.primaryBarcode,
    gtin: spec.gtin,
    upc: spec.upc,
    ean: spec.ean,
    vendorCodes: [],
    aliases: spec.aliasRawCodes.map((r) => cleanScanCode(r).cleanCode),
    imageUrl: spec.imageUrl,
    productUrl: "",
    location: spec.location,
    notes: "",
    status: "active",
    source: "seed",
    confidence: 1,
    verified: true, // seed data is manually verified, so its identifiers can count immediately
    createdAt: SEED_AT,
    updatedAt: SEED_AT,
    createdBy: "seed",
    updatedBy: "seed",
  };
}

function buildAliases(spec: SeedSpec): Alias[] {
  return spec.aliasRawCodes.map((raw, i) => {
    const cleaned = cleanScanCode(raw);
    const candidates = buildNormalizedCandidates(cleaned.cleanCode);
    const normalizedCode = candidates[candidates.length - 1] ?? cleaned.cleanCode;
    return {
      id: `${spec.id}-alias-${i}`,
      businessId: DEMO_BUSINESS_ID,
      productId: spec.id,
      rawCodeExample: raw,
      cleanCode: cleaned.cleanCode,
      normalizedCode,
      aliasType: i === 0 ? "barcode" : raw.match(/[^A-Za-z0-9]/) ? "messy_label" : "sku",
      source: "seed",
      confidence: 1,
      approved: true, // seed aliases are verified, so they resolve deterministically to Known
      createdAt: SEED_AT,
      updatedAt: SEED_AT,
      createdBy: "seed",
      lastSeenAt: SEED_AT,
      syncStatus: "synced",
      idempotencyKey: `seed:${spec.id}:alias:${i}`,
    };
  });
}

export function getSeedProducts(): Product[] {
  return SPECS.map(buildProduct);
}

export function getSeedAliases(): Alias[] {
  return SPECS.flatMap(buildAliases);
}

export function getSeed(): { products: Product[]; aliases: Alias[] } {
  return { products: getSeedProducts(), aliases: getSeedAliases() };
}
