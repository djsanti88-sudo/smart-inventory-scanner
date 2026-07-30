function text(value) {
  return String(value ?? "").trim();
}

export function isValidLocalDemoGtin(value) {
  const barcode = text(value);
  if (!/^\d{8}$|^\d{12,14}$/.test(barcode)) return false;
  const digits = [...barcode].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += digits[index] * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function isTrustedLocalDemoTireRow(row) {
  if (!row || typeof row !== "object") return false;
  const barcode = text(row.barcode);
  const model = text(row.model_display || row.model);
  return barcode.length !== 14
    && (barcode.length === 12 || barcode.length === 13)
    && isValidLocalDemoGtin(barcode)
    && Boolean(text(row.canonical_product_uid))
    && Boolean(text(row.brand))
    && Boolean(model)
    && Boolean(text(row.size))
    && text(row.current_status) === "active_retail"
    && text(row.usable_for) === "auto_count_candidate"
    && Number(row.source_count) >= 2
    && (text(row.barcode_type) === "upc" || text(row.barcode_type) === "ean");
}
