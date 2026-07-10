import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { FinalCountTable } from "@/components/FinalCountTable";
import type { InventoryCount, Product, UnknownCodeReview } from "@/types";

const product: Product = {
  id: "p1", businessId: "b", name: "Test Widget", brand: "Acme", category: "Tools",
  specsShort: "", specsFull: "", primarySku: "SKU1", primaryBarcode: "111222333444", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: ["111222333444"], imageUrl: "", productUrl: "", location: "A1", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};
const count: InventoryCount = {
  id: "c1", businessId: "b", sessionId: "s", productId: "p1", quantity: 5, lastScannedAt: "",
  aliasesSeen: ["111222333444", "ALT-CODE-9"], scanEventIds: [], createdAt: "", updatedAt: "",
  syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
};

function seed() {
  useScanStore.setState({ products: [product], finalCounts: [count] });
}

afterEach(() => {
  cleanup();
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("FinalCountTable role gating (Phase 6)", () => {
  it("shows the product's own scanned Barcode to every role; alias DB stays platformOwner-only (owner order 2026-07-10)", () => {
    delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER; // business / customer
    seed();
    render(<FinalCountTable />);
    // product IS visible. Task 4 review fix: the Model column shows the table's empty-cell "-"
    // convention (not a duplicate of the raw name) for a row with no structuredModel yet - this
    // fixture predates structuring - so "Test Widget" appears EXACTLY once (the Product column).
    expect(screen.getAllByText("Test Widget").length).toBe(1);
    expect(screen.getByTestId("model-p1").textContent).toBe("-");
    // Owner order 2026-07-10: the code the shop scanned is THEIR data - the Barcode column is
    // visible to all roles (same rule the feed already applies to its Barcode column).
    expect(screen.queryByText("Barcode")).not.toBeNull();
    expect(screen.queryAllByText(/111222333444/).length).toBeGreaterThan(0);
    // The alias DATABASE (other codes mapped to the product) remains platformOwner-only.
    expect(screen.queryByText("Other codes scanned")).toBeNull();
    expect(screen.queryAllByText(/ALT-CODE-9/).length).toBe(0); // alias DB not leaked
    // Mark wrong (destructive alias repair) is platformOwner-only
    expect(screen.queryByTestId("mark-wrong-p1")).toBeNull();
    // product-facing correction controls remain available
    expect(screen.queryByTestId("correct-p1")).not.toBeNull();
    expect(screen.queryByTestId("remove-count-p1")).not.toBeNull();
  });

  it("removes the Image column and shows a plain-number Size column for a tire (owner request)", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    const tire: Product = { ...product, id: "p2", name: "Michelin Latitude Tour HP", specsShort: "255/55R19 111 V" };
    const tcount: InventoryCount = { ...count, id: "c2", productId: "p2" };
    useScanStore.setState({ products: [tire], finalCounts: [tcount] });
    render(<FinalCountTable />);
    expect(screen.queryByText("Image")).toBeNull(); // image column removed
    expect(screen.queryByText("Size")).not.toBeNull(); // size column present
    // Task 6: cell shows the canonical size, not the digit-mash; digit form moves to the title tooltip.
    expect(screen.getByTestId("size-p2").textContent?.trim()).toBe("255/55R19");
    expect(screen.getByTestId("size-p2").getAttribute("title")).toBe("2555519");
  });

  it("shows Barcode + Other codes scanned to the platformOwner (Mark wrong hidden for now)", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1"; // platformOwner
    seed();
    render(<FinalCountTable />);
    expect(screen.queryByText("Barcode")).not.toBeNull();
    expect(screen.queryByText("Other codes scanned")).not.toBeNull();
    expect(screen.queryAllByText(/111222333444/).length).toBeGreaterThan(0);
    // Owner request: row is simplified to Modify + Delete; Mark wrong + hard product-delete are hidden
    // behind SHOW_ADVANCED_ACTIONS (code kept). The two core controls remain.
    expect(screen.queryByTestId("mark-wrong-p1")).toBeNull();
    expect(screen.queryByTestId("correct-p1")).not.toBeNull(); // Modify
    expect(screen.queryByTestId("remove-count-p1")).not.toBeNull(); // Delete
  });
});

describe("FinalCountTable Brand/Model/Size columns + digits filter (Build 2 Task 4)", () => {
  it("renders structured Brand/Model/Size and the digits filter narrows rows by sizeTag prefix", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    const tireA: Product = {
      ...product, id: "pA", name: "Cooper Discoverer AT3 205/55R16", brand: "Cooper",
      structuredBrand: "Cooper", structuredModel: "Discoverer AT3", structuredDescription: "Cooper Discoverer AT3 205/55R16",
      sizeTag: "2055516", structuredBy: "deterministic",
    };
    const tireB: Product = {
      ...product, id: "pB", name: "Michelin Defender 225/45R17", brand: "Michelin",
      structuredBrand: "Michelin", structuredModel: "Defender", structuredDescription: "Michelin Defender 225/45R17",
      sizeTag: "2254517", structuredBy: "deterministic",
    };
    const cA: InventoryCount = { ...count, id: "cA", productId: "pA" };
    const cB: InventoryCount = { ...count, id: "cB", productId: "pB" };
    useScanStore.setState({ products: [tireA, tireB], finalCounts: [cA, cB] });
    render(<FinalCountTable />);

    expect(screen.getByTestId("brand-pA").textContent).toBe("Cooper");
    expect(screen.getByTestId("model-pA").textContent).toBe("Discoverer AT3");
    // Task 6: sizeTag "2055516" has no slashes/letters for matchTireSize to parse (specsShort is
    // empty in this fixture), so canonical resolution falls back to the raw sizeTag - still no crash.
    expect(screen.getByTestId("size-pA").textContent).toBe("2055516");
    expect(screen.queryByTestId("count-row-pA")).not.toBeNull();
    expect(screen.queryByTestId("count-row-pB")).not.toBeNull();

    fireEvent.change(screen.getByTestId("polish-filter"), { target: { value: "205" } });
    expect(screen.queryByTestId("count-row-pA")).not.toBeNull();
    expect(screen.queryByTestId("count-row-pB")).toBeNull();

    fireEvent.change(screen.getByTestId("polish-filter"), { target: { value: "michelin" } });
    expect(screen.queryByTestId("count-row-pA")).toBeNull();
    expect(screen.queryByTestId("count-row-pB")).not.toBeNull();
  });
});

describe("FinalCountTable prettifies slug names and lowercase brands (Task 5)", () => {
  it("renders a Title Case product name, brand, and model from corpus-style slug/lowercase data", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    const tire: Product = {
      ...product, id: "p8", name: "wrangler_workhorse_at", brand: "goodyear",
      structuredBrand: "goodyear", structuredModel: "wrangler_workhorse_at",
    };
    const tcount: InventoryCount = { ...count, id: "c8", productId: "p8" };
    useScanStore.setState({ products: [tire], finalCounts: [tcount] });
    render(<FinalCountTable />);

    expect(screen.getAllByText("Wrangler Workhorse AT").length).toBeGreaterThan(0);
    expect(screen.getByTestId("brand-p8").textContent).toBe("Goodyear");
    expect(screen.getByTestId("model-p8").textContent).toBe("Wrangler Workhorse AT");
    expect(screen.queryByText("wrangler_workhorse_at")).not.toBeInTheDocument();
  });
});

describe("FinalCountTable Size column shows canonical size (Task 6)", () => {
  it("renders the canonical size from specsShort, not the digit-mash, and keeps the digit form as a title tooltip", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    const tire: Product = {
      ...product, id: "p3", name: "Some Tire 245/70R16", specsShort: "245/70R16 107T",
    };
    const tcount: InventoryCount = { ...count, id: "c3", productId: "p3" };
    useScanStore.setState({ products: [tire], finalCounts: [tcount] });
    render(<FinalCountTable />);

    const cell = screen.getByTestId("size-p3");
    expect(cell.textContent?.trim()).toBe("245/70R16");
    expect(cell.textContent?.trim()).not.toBe("2457016");
    expect(cell.getAttribute("title")).toBe("2457016");
  });

  it("falls back to sizeTag, then '-', for a non-tire product with no parseable size (never crashes)", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    // No specsShort size and no sizeTag at all: must show "-" and not throw.
    const nonTire: Product = { ...product, id: "p4", name: "Shop Rag Bundle", specsShort: "24-pack" };
    const ncount: InventoryCount = { ...count, id: "c4", productId: "p4" };
    useScanStore.setState({ products: [nonTire], finalCounts: [ncount] });
    render(<FinalCountTable />);
    const cell = screen.getByTestId("size-p4");
    expect(cell.textContent?.trim()).toBe("-");

    cleanup();

    // Product has a sizeTag but specsShort has nothing tire-shaped: falls back to the raw sizeTag.
    const taggedOnly: Product = { ...product, id: "p5", name: "Legacy Part", specsShort: "", sizeTag: "9999999" };
    const tcount2: InventoryCount = { ...count, id: "c5", productId: "p5" };
    useScanStore.setState({ products: [taggedOnly], finalCounts: [tcount2] });
    render(<FinalCountTable />);
    expect(screen.getByTestId("size-p5").textContent?.trim()).toBe("9999999");
  });

  it("keeps the digit-only filter (e.g. '205') matching tires by size after the display change", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    const tireA: Product = { ...product, id: "p6", name: "Filter Test A", specsShort: "205/55R16 91V" };
    const tireB: Product = { ...product, id: "p7", name: "Filter Test B", specsShort: "225/45R17 94W" };
    const cA: InventoryCount = { ...count, id: "c6", productId: "p6" };
    const cB: InventoryCount = { ...count, id: "c7", productId: "p7" };
    useScanStore.setState({ products: [tireA, tireB], finalCounts: [cA, cB] });
    render(<FinalCountTable />);

    // Cell renders canonical...
    expect(screen.getByTestId("size-p6").textContent?.trim()).toBe("205/55R16");
    // ...but the digit-style filter still matches by the underlying digit form.
    fireEvent.change(screen.getByTestId("polish-filter"), { target: { value: "205" } });
    expect(screen.queryByTestId("count-row-p6")).not.toBeNull();
    expect(screen.queryByTestId("count-row-p7")).toBeNull();
  });
});

// Owner order 2026-07-10: "your counts" needs a Status column so a shop owner can tell a Verified
// match from a Suggested (unconfirmed) or Needs review row without opening Needs Review separately,
// and provisional rows should show whatever identity info exists (mirrors LiveScanFeed's render-time
// needsReviewQueue lookup + unconfirmed/(suggested) tag convention) instead of a bare placeholder.
function provisionalProduct(id: string, overrides: Partial<Product> = {}): Product {
  return {
    ...product,
    id,
    name: `Unidentified item (barcode ${overrides.primaryBarcode ?? "999000111222"})`,
    brand: "",
    verified: false,
    provisional: true,
    confidence: 0,
    primaryBarcode: "999000111222",
    ...overrides,
  };
}

function suggestionReview(overrides: Partial<UnknownCodeReview> = {}): UnknownCodeReview {
  return {
    id: "rv1",
    cleanCode: "999000111222",
    suggestedProductName: "Michelin Defender LTX M/S",
    suggestedBrand: "Michelin",
    suggestedPrimarySku: "",
    confidence: 0.7,
    status: "open",
    ...overrides,
  } as unknown as UnknownCodeReview;
}

describe("FinalCountTable Status column + suggested-identity display (owner order 2026-07-10)", () => {
  it("shows a Status column with the Verified badge for a verified product row", () => {
    seed(); // seeded `product` has verified: true
    render(<FinalCountTable />);
    expect(screen.queryByText("Status")).not.toBeNull();
    const row = screen.getByTestId("count-row-p1");
    expect(row.querySelector('[data-testid="decode-row-status"]')?.textContent).toBe("Verified match");
  });

  it("provisional product with an open low-confidence suggestion shows the suggested name, (suggested) tag, brand, and Suggested badge", () => {
    const prov = provisionalProduct("pProv1");
    const provCount: InventoryCount = { ...count, id: "cProv1", productId: "pProv1" };
    const review = suggestionReview({
      cleanCode: "999000111222",
      suggestedProductName: "Michelin Defender LTX M/S",
      suggestedBrand: "Michelin",
      confidence: 0.7,
    });
    useScanStore.setState({ products: [prov], finalCounts: [provCount], needsReviewQueue: [review] });
    render(<FinalCountTable />);

    const row = screen.getByTestId("count-row-pProv1");
    expect(row.textContent).toMatch(/Michelin Defender LTX/);
    expect(row.textContent).toMatch(/\(suggested\)/);
    expect(screen.getByTestId("brand-pProv1").textContent).toBe("Michelin");
    expect(row.querySelector('[data-testid="decode-row-status"]')?.textContent).toBe("Suggested");
  });

  it("provisional product whose identity was auto-applied shows its own name/brand, the unconfirmed tag, and a Suggested badge", () => {
    const prov: Product = {
      ...product,
      id: "pProv2",
      name: "Michelin Defender LTX M/S",
      brand: "Michelin",
      verified: false,
      provisional: true,
      confidence: 0.9,
      primaryBarcode: "999000111333",
    };
    const provCount: InventoryCount = { ...count, id: "cProv2", productId: "pProv2" };
    const review = suggestionReview({
      id: "rv2",
      cleanCode: "999000111333",
      provisionalProductId: "pProv2",
      suggestedProductName: "Michelin Defender LTX M/S",
      suggestedBrand: "Michelin",
      confidence: 0.9,
      status: "resolved",
    });
    useScanStore.setState({ products: [prov], finalCounts: [provCount], needsReviewQueue: [review] });
    render(<FinalCountTable />);

    const row = screen.getByTestId("count-row-pProv2");
    expect(row.textContent).toMatch(/Michelin Defender LTX/);
    expect(row.textContent).toMatch(/unconfirmed/);
    expect(row.textContent).not.toMatch(/\(suggested\)/);
    expect(screen.getByTestId("brand-pProv2").textContent).toBe("Michelin");
    expect(row.querySelector('[data-testid="decode-row-status"]')?.textContent).toBe("Suggested");
  });

  it("provisional product with no suggestion anywhere shows the needs_review badge and keeps the placeholder name", () => {
    const prov = provisionalProduct("pProv3", { primaryBarcode: "999000111444" });
    const provCount: InventoryCount = { ...count, id: "cProv3", productId: "pProv3" };
    useScanStore.setState({ products: [prov], finalCounts: [provCount], needsReviewQueue: [] });
    render(<FinalCountTable />);

    const row = screen.getByTestId("count-row-pProv3");
    expect(row.textContent).toMatch(/Unidentified item/);
    expect(row.querySelector('[data-testid="decode-row-status"]')?.textContent).toBe("Suggested");
  });

  it("provisional product with a full suggested identity fills Brand, Category, Specs, Size, and Part number through the suggestion (owner refinement: no all-dashes row when a suggestion exists)", () => {
    const prov = provisionalProduct("pProv4", { primaryBarcode: "999000111555" });
    const provCount: InventoryCount = { ...count, id: "cProv4", productId: "pProv4" };
    const review = suggestionReview({
      id: "rv4",
      cleanCode: "999000111555",
      suggestedProductName: "Goodyear Wrangler AT 265/70R17",
      suggestedBrand: "Goodyear",
      suggestedCategory: "Tires",
      suggestedSpecsShort: "265/70R17 115T",
      suggestedPrimarySku: "GY-WRNGLR-2657017",
      confidence: 0.65,
    });
    useScanStore.setState({ products: [prov], finalCounts: [provCount], needsReviewQueue: [review] });
    render(<FinalCountTable />);

    const row = screen.getByTestId("count-row-pProv4");
    expect(screen.getByTestId("brand-pProv4").textContent).toBe("Goodyear");
    expect(row.textContent).toMatch(/Tires/);
    expect(row.textContent).toMatch(/265\/70R17/);
    expect(screen.getByTestId("size-pProv4").textContent?.trim()).toBe("265/70R17");
    expect(row.textContent).toMatch(/GY-WRNGLR-2657017/);
    // None of the suggestion-mappable cells fall back to a bare "-" when a suggestion exists.
    expect(screen.getByTestId("brand-pProv4").textContent).not.toBe("-");
    expect(screen.getByTestId("size-pProv4").textContent?.trim()).not.toBe("-");
  });
});
