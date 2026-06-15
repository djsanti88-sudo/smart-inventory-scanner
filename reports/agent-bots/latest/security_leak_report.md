# SecurityLeakBot report (safe, non-destructive)

> Status: UI hiding + export sanitization + customer de-branding are now in place (Sec-1/2/3) for
> non-platformOwner roles, so the Products code columns and AI/provider wording no longer appear here.
> What REMAINS (Sec-4/5, the architecture cutover) is that the customer browser still DOWNLOADS + PERSISTS
> the alias/catalog DB (localStorage + network) until server-side customer resolution lands. This run is
> report-only and non-destructive; remaining P0 items are the localStorage/network DB, listed below.

- P0 findings: **2**  |  P1: **8**  |  P2: **0**

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

## Headline (P0, before any pilot with non-owner users)
- The customer browser holds the full alias/catalog database in localStorage, and code columns/exports
  are visible to all roles. This is exactly what the DEFERRED foundation must fix (server-side customer
  resolution + role-aware serializers + customer code hiding). See docs/HOTFIX_FOLLOWUPS.md.

Screenshots: e2e/proof/agent-bots/security/
