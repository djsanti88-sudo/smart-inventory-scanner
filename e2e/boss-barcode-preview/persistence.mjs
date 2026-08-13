export function persistedPreviewLaneIsTrusted({ events, products, counts, reviews, expectedEvents, expectedByCanonical }) {
  const productById = new Map(products.map((product) => [product.id, product]));
  const terminal = events.length === expectedEvents && events.every((event) => {
    const product = productById.get(event.matchedProductId);
    return event.status === "known" && (event.decodeStatus === "verified" || event.decodeStatus === "none" || event.decodeStatus == null) &&
      product?.status === "active" && product?.verified === true && product?.provisional !== true && typeof product?.trustedExactCanonicalId === "string";
  });
  const actual = new Map();
  const total = counts.reduce((sum, count) => sum + Number(count.countedQuantity ?? count.quantity ?? 0), 0);
  for (const count of counts) {
    const quantity = Number(count.countedQuantity ?? count.quantity ?? 0); const product = productById.get(count.productId);
    if (quantity > 0 && product?.trustedExactCanonicalId) actual.set(product.trustedExactCanonicalId, (actual.get(product.trustedExactCanonicalId) ?? 0) + quantity);
  }
  const expected = Object.entries(expectedByCanonical).sort(([a], [b]) => a.localeCompare(b));
  const actualEntries = [...actual.entries()].sort(([a], [b]) => a.localeCompare(b));
  return terminal && total === expectedEvents && JSON.stringify(actualEntries) === JSON.stringify(expected) && reviews.every((review) => review.status === "resolved");
}
