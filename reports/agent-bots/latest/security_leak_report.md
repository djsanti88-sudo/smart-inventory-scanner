# SecurityLeakBot report (safe, non-destructive)

> Client-side role gating (platformOwner vs customer) is NOT implemented yet (DEFERRED foundation). So
> today EVERY authenticated user sees these. This run documents the current exposure honestly; it does
> not exploit anything. Once the role/data-protection foundation lands, these become hard failures.

- P0 findings: **3**  |  P1: **12**  |  P2: **3**

| severity | surface | finding | detail |
|----------|---------|---------|--------|
| P0 | localStorage (sis-scan-v1) | Customer browser holds the alias database (cleanCode/normalizedCode values) | ~13 alias code entries persisted client-side |
| P0 | localStorage (sis-scan-v1) | Customer browser holds the shared catalog object | global catalog persisted client-side (downloadable) |
| P1 | localStorage | internal field present in client store: aliases | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: catalog | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: normalizedCode | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: cleanCode | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: gtin | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: upc | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: ean | field serialized into the browser store |
| P1 | localStorage | internal field present in client store: rawCodeExample | field serialized into the browser store |
| P0 | /products | Products page shows raw code columns (barcode/GTIN/UPC/EAN/aliases) | no role gate; visible to any logged-in user |
| P1 | /review | customer-facing UI exposes term "provider" | internal/AI mechanics shown to customer-facing roles |
| P1 | /settings | customer-facing UI exposes term "Gemini" | internal/AI mechanics shown to customer-facing roles |
| P1 | /settings | customer-facing UI exposes term "OpenAI" | internal/AI mechanics shown to customer-facing roles |
| P2 | /settings | customer-facing UI exposes term "AI lookup" | internal/AI mechanics shown to customer-facing roles |
| P2 | /settings | customer-facing UI exposes term "AI decode" | internal/AI mechanics shown to customer-facing roles |
| P1 | /settings | customer-facing UI exposes term "provider" | internal/AI mechanics shown to customer-facing roles |
| P2 | /settings | customer-facing UI exposes term "evidence" | internal/AI mechanics shown to customer-facing roles |

## Headline (P0, before any pilot with non-owner users)
- The customer browser holds the full alias/catalog database in localStorage, and code columns/exports
  are visible to all roles. This is exactly what the DEFERRED foundation must fix (server-side customer
  resolution + role-aware serializers + customer code hiding). See docs/HOTFIX_FOLLOWUPS.md.

Screenshots: e2e/proof/agent-bots/security/
