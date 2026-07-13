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
