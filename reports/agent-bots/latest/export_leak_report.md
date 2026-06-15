# ExportBot report

> Role-segregated exports are part of the DEFERRED foundation. Today there is ONE effective role and
> all exports are available with raw code fields. This documents which exports MUST be sanitized/owner-only
> before non-platformOwner roles exist.

| export | code-bearing fields in header |
|--------|-------------------------------|
| final counts | primary_barcode, gtin, upc, ean, aliases |
| products | primary_barcode, gtin, upc, ean, aliases |
| aliases | ean, raw_code, clean_code, normalized, raw_code_example, normalized_code |
| raw scan log | ean, raw_code, clean_code, normalized |
| unknowns | ean, raw_code, clean_code, normalized, provider |

**5 of 5 exports contain raw/internal code fields** and must be platformOwner-only or sanitized for customer roles. Headers captured in export_headers_by_role.json. Screenshots: e2e/proof/agent-bots/export/
