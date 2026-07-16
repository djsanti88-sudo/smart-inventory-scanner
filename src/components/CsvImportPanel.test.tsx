import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { CsvImportPanel } from "@/components/CsvImportPanel";
import type { Product, Alias } from "@/types";

// Task 3.6: CSV import onboarding panel. Preview-first, explicit confirm - NEVER imports
// automatically on file selection. Reads/writes the real store's products + aliases directly.

function makeFile(text: string, name = "products.csv"): File {
  return new File([text], name, { type: "text/csv" });
}

async function selectFile(text: string, name = "products.csv") {
  const input = screen.getByTestId("csv-import-file-input") as HTMLInputElement;
  const file = makeFile(text, name);
  await fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  useScanStore.setState({
    businessId: "biz-test",
    products: [] as Product[],
    aliases: [] as Alias[],
  });
});

afterEach(() => {
  cleanup();
});

describe("CsvImportPanel - file input + preview", () => {
  it("renders a file input", () => {
    render(<CsvImportPanel />);
    expect(screen.getByTestId("csv-import-file-input")).toBeInTheDocument();
  });

  it("shows a preview table of up to the first 20 rows after selecting a file, without importing", async () => {
    const text = "name,sku,barcode,qty\nWidget A,SKU1,111111111,5\nWidget B,SKU2,222222222,2";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    expect(screen.getByText("Widget A")).toBeInTheDocument();
    expect(screen.getByText("Widget B")).toBeInTheDocument();

    // Nothing applied yet - store still empty.
    expect(useScanStore.getState().products).toHaveLength(0);
  });

  it("caps the preview table at the first 20 rows", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `Widget ${i + 1},SKU${i + 1},${1000000000 + i}`);
    const text = `name,sku,barcode\n${lines.join("\n")}`;
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    const rows = screen.getAllByTestId(/^csv-import-preview-row-/);
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  it("shows an error list with line + reason for bad rows", async () => {
    const text = "name,sku\n,SKU1\nWidget,SKU2";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-errors")).toBeInTheDocument());
    expect(screen.getByTestId("csv-import-error-0")).toHaveTextContent(/line 2/i);
    expect(screen.getByTestId("csv-import-error-0")).toHaveTextContent(/name/i);
  });

  it("does not show an error list when there are no bad rows", async () => {
    const text = "name,sku\nWidget,SKU1";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    expect(screen.queryByTestId("csv-import-errors")).not.toBeInTheDocument();
  });
});

describe("CsvImportPanel - carries brand/category/specs/location into the created product (QA Task 3)", () => {
  it("applies brand, category, specs, and location from the CSV row onto the created product", async () => {
    const text = "name,sku,barcode,brand,category,specs,location\nWidget,SKU1,111111111,Acme,Tools,10mm,Aisle 3";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));

    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());
    const [product] = useScanStore.getState().products;
    expect(product.brand).toBe("Acme");
    expect(product.category).toBe("Tools");
    expect(product.specsShort).toBe("10mm");
    expect(product.location).toBe("Aisle 3");
  });
});

describe("CsvImportPanel - unmapped-header warning (QA Task 3)", () => {
  it("shows a warning listing columns that were not imported", async () => {
    const text = "name,sku,supplier,notes\nWidget,SKU1,Acme Distribution,fragile";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-unmapped-warning")).toBeInTheDocument());
    expect(screen.getByTestId("csv-import-unmapped-warning")).toHaveTextContent("supplier");
    expect(screen.getByTestId("csv-import-unmapped-warning")).toHaveTextContent("notes");
  });

  it("does not show the unmapped-header warning when every column is recognized", async () => {
    const text = "name,sku,barcode,brand,category,specs,location\nWidget,SKU1,111,Acme,Tools,10mm,Aisle 3";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-preview")).toBeInTheDocument());
    expect(screen.queryByTestId("csv-import-unmapped-warning")).not.toBeInTheDocument();
  });
});

describe("CsvImportPanel - explicit confirm required", () => {
  it("shows a confirm button labeled with the count of valid rows about to be applied", async () => {
    const text = "name,sku\nWidget A,SKU1\nWidget B,SKU2";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    expect(screen.getByTestId("csv-import-confirm")).toHaveTextContent("Import 2 products");
  });

  it("does NOT apply the import until the confirm button is clicked", async () => {
    const text = "name,sku,barcode\nWidget A,SKU1,111111111";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    expect(useScanStore.getState().products).toHaveLength(0);
  });

  it("applies the import and shows the summary when confirm is clicked", async () => {
    const text = "name,sku,barcode,qty\nWidget A,SKU1,111111111,5";
    render(<CsvImportPanel />);
    await selectFile(text);

    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));

    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());
    expect(useScanStore.getState().products).toHaveLength(1);
    expect(useScanStore.getState().aliases).toHaveLength(1);
    expect(screen.getByTestId("csv-import-summary")).toHaveTextContent("1");
  });
});

describe("CsvImportPanel - QA Task 7: re-import of an existing barcode refreshes fields, honest copy, never a quantity implication", () => {
  it("importing file A then file B (same barcode, different name/brand) refreshes the existing product's descriptive fields and shows honest 'fields refreshed' copy", async () => {
    const fileA = "name,sku,barcode,brand,category,specs,location\nWidget A,SKU1,111111111,OldBrand,OldCat,OldSpec,Old Aisle";
    const fileB = "name,sku,barcode,brand,category,specs,location\nWidget A Updated,SKU1,111111111,NewBrand,NewCat,NewSpec,New Aisle";

    // --- Import file A: creates the product. ---
    const { unmount } = render(<CsvImportPanel />);
    await selectFile(fileA, "a.csv");
    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));
    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());

    expect(useScanStore.getState().products).toHaveLength(1);
    expect(useScanStore.getState().products[0].brand).toBe("OldBrand");
    unmount();

    // --- Import file B: SAME barcode, different name/brand/category/specs/location. ---
    render(<CsvImportPanel />);
    await selectFile(fileB, "b.csv");
    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));
    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());

    const { products } = useScanStore.getState();
    expect(products).toHaveLength(1); // still exactly one product - never a duplicate
    expect(products[0].name).toBe("Widget A Updated");
    expect(products[0].brand).toBe("NewBrand");
    expect(products[0].category).toBe("NewCat");
    expect(products[0].specsShort).toBe("NewSpec");
    expect(products[0].location).toBe("New Aisle");

    // Honest copy: "matched existing product(s) (fields refreshed)" - no quantity implication anywhere.
    const summaryText = screen.getByTestId("csv-import-summary").textContent ?? "";
    expect(summaryText).toMatch(/matched existing product.*fields refreshed/i);
    expect(summaryText).not.toMatch(/merged into existing/i);
    expect(summaryText).not.toMatch(/quantity|qty/i);
  });

  it("idempotency: re-importing the exact same file (file B) a second time nets zero further changes", async () => {
    const fileB = "name,sku,barcode,brand\nWidget A Updated,SKU1,111111111,NewBrand";

    const { unmount } = render(<CsvImportPanel />);
    await selectFile(fileB, "b.csv");
    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));
    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());

    const afterFirst = JSON.parse(JSON.stringify(useScanStore.getState().products));
    unmount();

    // Re-upload the SAME file content again (fresh panel instance, simulating a re-upload).
    render(<CsvImportPanel />);
    await selectFile(fileB, "b.csv");
    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));
    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());

    const afterSecond = useScanStore.getState().products;
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond).toEqual(afterFirst); // net-zero change on the identical re-import
    expect(screen.getByTestId("csv-import-summary")).toHaveTextContent("1 row skipped");
  });
});

describe("CsvImportPanel - store-level double-apply is a true no-op (idempotent re-import)", () => {
  it("uploading and confirming the SAME fixture CSV twice writes products/aliases/quantities identically after both confirms (zero new writes on the second)", async () => {
    const text = "name,sku,barcode,qty\nWidget A,SKU1,111111111,5\nWidget B,SKU2,222222222,2";

    // --- First import ---
    const { unmount } = render(<CsvImportPanel />);
    await selectFile(text);
    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));
    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());

    const afterFirst = useScanStore.getState();
    expect(afterFirst.products).toHaveLength(2);
    expect(afterFirst.aliases).toHaveLength(2);
    const productsAfterFirst = JSON.parse(JSON.stringify(afterFirst.products));
    const aliasesAfterFirst = JSON.parse(JSON.stringify(afterFirst.aliases));
    unmount();

    // --- Second import: same file content, fresh panel instance (simulates re-upload) ---
    render(<CsvImportPanel />);
    await selectFile(text);
    await waitFor(() => expect(screen.getByTestId("csv-import-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("csv-import-confirm"));
    await waitFor(() => expect(screen.getByTestId("csv-import-summary")).toBeInTheDocument());

    const afterSecond = useScanStore.getState();

    // Zero new writes: identical counts and identical row content (deep equal), not just same length.
    expect(afterSecond.products).toHaveLength(2);
    expect(afterSecond.aliases).toHaveLength(2);
    expect(afterSecond.products).toEqual(productsAfterFirst);
    expect(afterSecond.aliases).toEqual(aliasesAfterFirst);

    // The summary on the second confirm must report the re-import as fully skipped, not re-applied.
    expect(screen.getByTestId("csv-import-summary")).toHaveTextContent("0 products created");
    expect(screen.getByTestId("csv-import-summary")).toHaveTextContent("2 rows skipped");
  });
});
