// Build 2 / Task 4: pure filter logic for the final-count table's single polish filter input.
// A digits-only query filters by sizeTag PREFIX ("205" matches "2055516"); any other query filters
// brand / model / description case-insensitively. Pure, no React/next imports - table-agnostic so
// it is unit-testable on its own and reusable by any row shape that carries these four fields.
//
// taskD4 fix (W3 data-flows bot repro): the Size column renders the human-readable size WITH slashes
// ("275/55R20"), but sizeTag only ever holds the digit-mash ("2755520"). A query that is not entirely
// digits (because it has a "/" from being typed or pasted straight off the screen) used to skip the
// sizeTag check completely and fall through to brand/model/description text search, which never
// contains the size - so the single most natural query (the size exactly as shown) returned zero
// results. Fix: ALSO strip non-digit characters from any query and match that against the sizeTag
// prefix, in addition to (never instead of) the existing text search. No regex is built from user
// input at any point (plain .includes()/.startsWith()), so an adversarial query can never throw.

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

  const sizeDigits = q.replace(/\D/g, "");
  const needle = q.toLowerCase();
  return rows.filter(
    (r) =>
      (!!sizeDigits && (r.sizeTag ?? "").startsWith(sizeDigits)) ||
      (r.brand ?? "").toLowerCase().includes(needle) ||
      (r.model ?? "").toLowerCase().includes(needle) ||
      (r.description ?? "").toLowerCase().includes(needle),
  );
}
