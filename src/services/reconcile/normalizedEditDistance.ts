// src/services/reconcile/normalizedEditDistance.ts
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizedEditSimilarity(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
