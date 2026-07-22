// Build 2 / Task 4: pure filter logic for the final-count table's single polish filter input.
// A digits-only query filters by sizeTag PREFIX ("205" matches "2055516"); any other query filters
// brand / model / description case-insensitively. Pure, no React/next imports - table-agnostic so
// it is unit-testable on its own and reusable by any row shape that carries these four fields.

export interface FilterableRow {
  id: string;
  brand: string;
  model: string;
  description: string;
  sizeTag: string;
}

const DIGITS_ONLY_RE = /^\d+$/;

/** Trimmed, empty query returns every row unchanged (no filter applied). */
export function filterProducts<T extends FilterableRow>(rows: T[], query: string): T[] {
  const q = (query ?? "").trim();
  if (!q) return rows;

  if (DIGITS_ONLY_RE.test(q)) {
    return rows.filter((r) => (r.sizeTag ?? "").startsWith(q));
  }

  const needle = q.toLowerCase();
  return rows.filter(
    (r) =>
      (r.brand ?? "").toLowerCase().includes(needle) ||
      (r.model ?? "").toLowerCase().includes(needle) ||
      (r.description ?? "").toLowerCase().includes(needle),
  );
}
