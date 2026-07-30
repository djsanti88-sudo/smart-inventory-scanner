# GS1 Country / Region Reference (v1.0.0)

Implemented in `src/services/gs1Prefixes.ts`. Used ONLY as a non-authoritative hint to help the AI
lookup search. It is never product identity. This doc's scope also covers deterministic GTIN FORM
derivation (UPC-A/EAN-13 twin forms, below) - a separate, unrelated concern from the country/region
hint: form derivation is pure math on the code's own digits, never a guess about origin or brand.

## Disclaimer (mandated, shown in the AI prompt)
> GS1 numbering authority region only - not country of manufacture, not brand, and not product identity.

A GS1 prefix identifies the GS1 Member Organisation that ALLOCATED the company prefix. It is NOT where
the product was made, NOT the brand, and NOT the product's identity.

## How the prefix is read
- Only PUBLIC barcodes get a hint: `upc_a` (12 digits), `ean_13` (13 digits), `gtin_14` (14 digits).
  SKUs, vendor labels (X00.../FNSKU), messy, and empty codes return null.
- Normalize to a 13-digit GTIN-13 base, then read the leading 3 digits as the GS1 prefix:
  - UPC-A: left-pad with a leading zero to GTIN-13.
  - EAN-13: used as-is.
  - GTIN-14: drop the leading packaging-indicator digit to expose the embedded GTIN-13.
- An unmapped or intentionally-omitted prefix returns null (no guess).

## Implemented ranges (summary; the authoritative table is in code)
- 000-019, 030-039, 050-059, 060-139: United States and Canada (GS1 US)
- 020-029, 040-049, 200-299: Restricted distribution (internal / store / company use)
- 300-379 France; 380 Bulgaria; 383 Slovenia; 385 Croatia; 387 Bosnia and Herzegovina; 389 Montenegro
- 400-440 Germany; 450-459 and 490-499 Japan; 460-469 Russia
- 470 Kyrgyzstan; 471 Taiwan; 474 Estonia; 475 Latvia; 476 Azerbaijan; 477 Lithuania; 478 Uzbekistan;
  479 Sri Lanka; 480 Philippines; 481 Belarus; 482 Ukraine; 483 Turkmenistan; 484 Moldova; 485 Armenia;
  486 Georgia; 487 Kazakhstan; 488 Tajikistan; 489 Hong Kong
- 500-509 United Kingdom; 520-521 Greece; 528 Lebanon; 529 Cyprus; 530 Albania; 531 North Macedonia;
  535 Malta; 539 Ireland; 540-549 Belgium and Luxembourg; 560 Portugal; 569 Iceland;
  570-579 Denmark, Faroe Islands and Greenland
- 590 Poland; 594 Romania; 599 Hungary; 600-601 South Africa; 603 Ghana; 604 Senegal; 608 Bahrain;
  609 Mauritius; 611 Morocco; 613 Algeria; 615 Nigeria; 616 Kenya; 617 Cameroon; 618 Ivory Coast;
  619 Tunisia; 620 Tanzania; 621 Syria; 622 Egypt; 623 Brunei; 624 Libya; 625 Jordan; 626 Iran;
  627 Kuwait; 628 Saudi Arabia; 629 United Arab Emirates
- 640-649 Finland; 690-699 China; 700-709 Norway; 729 Israel; 730-739 Sweden
- 740 Guatemala; 741 El Salvador; 742 Honduras; 743 Nicaragua; 744 Costa Rica; 745 Panama;
  746 Dominican Republic; 750 Mexico; 754-755 Canada; 759 Venezuela;
  760-769 Switzerland and Liechtenstein; 770-771 Colombia; 773 Uruguay; 775 Peru; 777 Bolivia;
  778-779 Argentina; 780 Chile; 784 Paraguay; 786 Ecuador; 789-790 Brazil
- 800-839 Italy, San Marino and Vatican City; 840-849 Spain and Andorra; 850 Cuba; 858 Slovakia;
  859 Czech Republic; 860 Serbia; 865 Mongolia; 867 North Korea; 868-869 Turkey; 870-879 Netherlands;
  880 South Korea; 883 Myanmar; 884 Cambodia; 885 Thailand; 888 Singapore; 890 India; 893 Vietnam;
  896 Pakistan; 899 Indonesia
- 900-919 Austria; 930-939 Australia; 940-949 New Zealand; 950-951 GS1 Global Office; 955 Malaysia;
  958 Macau
- 977 Serial publications (ISSN); 978-979 Books and notated music (ISBN/ISMN); 980 Refund receipts;
  981-984 and 990-999 Coupons

If a prefix is not listed here, the function returns null rather than guessing.

## Why there is no brand / manufacturer prefix table
A proposed 500+ entry "tire manufacturer prefix" dataset was rejected. GS1 company prefixes do not
reliably decode to a specific brand, and the supplied dataset was machine-generated and corrupted (it
contained stray non-data text). Mapping a prefix to a brand would be fabricated identity, which
violates the project rule "prefer Needs Review over a wrong guess." Product identity comes only from
verified evidence plus human approval, never from a prefix lookup.

## Deriving UPC-A/EAN-13 twin forms

Deterministic derivation of a code's other public GTIN form, used by the tire-corpus twin-column
backfill (`.claude/skills/db-blank-filler/SKILL.md`, "twin - barcode twin COLUMN completion" stage).
Quoted verbatim from that skill's rule:

> - 13-digit starting with `0` -> `barcode_upc` = drop leading zero, `barcode_ean13` = itself.
> - 12-digit -> `barcode_upc` = itself, `barcode_ean13` = `'0' + itself`.
> - 13-digit NOT starting with `0` (69x China codes, etc.) -> `barcode_ean13` = itself,
>   `barcode_upc` = NULL. NEVER fabricate a UPC-A form that does not exist.
> - 8/14-digit or any non-12/13-digit shape -> both NULL.

This is pure re-derivation from the code's own digits (never an external lookup or a guess), and it is
idempotent - re-running it never changes an already-correct pair. It never overwrites the `barcode`
primary-key column itself, only the two derived twin columns.

The runtime contract test for this rule at the scan-resolution layer (proving a tire's EAN-13 scan and
its UPC-A twin scan resolve to ONE product with quantity 2, never two products) is
`src/stores/eanUpcTwinDedup.store.test.ts` - see the `db-blank-filler` skill's "RUNTIME CONTRACT STAGE"
section for the full contract-test policy.

## Trust boundaries (recap)
- The GS1 hint is a hint, not identity truth.
- Discovered aliases remain suggestions until human approval.
- Customer roles must not see raw or internal decode diagnostics (including GS1 diagnostics).
