import { filterProducts, type FilterableRow } from "@/services/polish/filterProducts";
import type { InventoryCount, Product } from "@/types";

export interface FinalCountRow {
  count: InventoryCount;
  product: Product;
}

interface FinalCountRowInputs {
  finalCounts: readonly InventoryCount[];
  products: readonly Product[];
  currentSessionId: string | undefined;
}

interface FinalCountRowSelector {
  (inputs: FinalCountRowInputs): readonly FinalCountRow[];
  getBuildCount(): number;
}

/**
 * Keeps the expensive count-to-product join and quantity sort stable until one of its actual
 * inputs changes. Store updates to review state, aliases, actions, or table-local pagination do
 * not need a new 250-row model.
 */
export function createFinalCountRowSelector(): FinalCountRowSelector {
  let previousInputs: FinalCountRowInputs | undefined;
  let previousRows: readonly FinalCountRow[] = [];
  let buildCount = 0;

  const select = (inputs: FinalCountRowInputs): readonly FinalCountRow[] => {
    if (
      previousInputs
      && previousInputs.finalCounts === inputs.finalCounts
      && previousInputs.products === inputs.products
      && previousInputs.currentSessionId === inputs.currentSessionId
    ) {
      return previousRows;
    }

    const productById = new Map(inputs.products.map((product) => [product.id, product]));
    const rows: FinalCountRow[] = [];
    for (const count of inputs.finalCounts) {
      if (inputs.currentSessionId && count.sessionId !== inputs.currentSessionId) continue;
      const product = productById.get(count.productId);
      if (product) rows.push({ count, product });
    }
    rows.sort((a, b) => b.count.quantity - a.count.quantity);

    previousInputs = inputs;
    previousRows = rows;
    buildCount += 1;
    return rows;
  };

  select.getBuildCount = () => buildCount;
  return select;
}

/** Empty search preserves the row-model reference so pagination only slices it at render time. */
export function filterFinalCountRows(
  rows: readonly FinalCountRow[],
  query: string,
  toFilterable: (row: FinalCountRow) => FilterableRow = (row) => ({
    id: row.count.id,
    brand: row.product.structuredBrand || row.product.brand,
    model: row.product.structuredModel || "",
    description: row.product.structuredDescription || row.product.name,
    sizeTag: row.product.sizeTag || "",
  }),
): readonly FinalCountRow[] {
  if (!query.trim()) return rows;

  const filterable = rows.map(toFilterable);
  const kept = new Set(filterProducts(filterable, query).map((row) => row.id));
  return rows.filter((row) => kept.has(row.count.id));
}
