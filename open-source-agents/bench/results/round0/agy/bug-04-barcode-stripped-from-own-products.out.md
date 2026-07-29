# Code Review: bug-04-barcode-stripped-from-own-products

## Overview
Review of `src/services/security/sensitiveFields.ts`. The module defines denylists (`SENSITIVE_FIELDS`) and recursive sanitization utility (`stripSensitive`) alongside allowlists (`CUSTOMER_SAFE_PRODUCT_FIELDS`, `CUSTOMER_SAFE_REVIEW_FIELDS`, `CUSTOMER_SAFE_SCANEVENT_FIELDS`).

---

## Defect 1: Hard Denylist Conflict Stripping Required Fields (`cleanCode`, `idempotencyKey`)

### Concrete Failure Scenario
`CUSTOMER_SAFE_REVIEW_FIELDS` and `CUSTOMER_SAFE_SCANEVENT_FIELDS` explicitly include `"cleanCode"` and `"idempotencyKey"`, documenting that customers must see their own scanned barcodes in activity logs and require idempotency keys for offline synchronization.

However, `SENSITIVE_FIELDS` includes:
- `"cleanCode"` (line 12)
- `"idempotencyKey"` (line 26)

When `stripSensitive` is called on a customer's scan feed event or review item:
1. `isSensitiveKey("cleanCode")` returns `true`.
2. `isSensitiveKey("idempotencyKey")` returns `true`.

`stripSensitive` strips both `"cleanCode"` and `"idempotencyKey"`. As a result:
- Customer scan activity logs lose the physically scanned barcode upon reload.
- Pending sync items created from sanitized events lose their idempotency key, causing sync retries to duplicate or fail.

### Root Cause
`SENSITIVE_FIELDS` contains keys (`cleanCode`, `idempotencyKey`) that are explicitly allowed and required in `CUSTOMER_SAFE_REVIEW_FIELDS` and `CUSTOMER_SAFE_SCANEVENT_FIELDS`. `stripSensitive` applies `SENSITIVE_FIELDS` blindly without checking the entity scope or allowlist.

---

## Defect 2: Stripping Barcodes from Customer-Owned Products

### Concrete Failure Scenario
A customer accesses their own product catalog. To sanitize server responses, `stripSensitive` is called on product entities.

`SENSITIVE_FIELDS` contains:
```ts
"barcode", "barcodes", "primaryBarcode", "primary_barcode", "gtin", "upc", "ean"
```
When `stripSensitive` sanitizes product objects owned by the customer's business, all barcode identifiers (`primaryBarcode`, `barcode`, `gtin`, `upc`, `ean`) are stripped from the product objects. The customer receives products with missing barcode fields, preventing them from viewing or managing barcodes on their own inventory items.

### Root Cause
`SENSITIVE_FIELDS` treats all product barcode fields as global secrets across all contexts, failing to differentiate between a tenant's own product barcodes and global catalog/provider decode traces.

---

## Defect 3: Overly Broad Generic Denylist Key (`"prompt"`)

### Concrete Failure Scenario
Line 25 includes the generic string `"prompt"` in `SENSITIVE_FIELDS`. Any UI payload, settings object, or user input object containing a property named `prompt` (e.g., UI dialog prompts, user prompt preferences, or prompt label strings) will have that property deleted when passed through `stripSensitive`.

### Root Cause
Including a generic noun (`"prompt"`) in a global recursive key denylist causes collateral stripping of non-sensitive UI/application properties bearing the same key name.
