# Products

What a product is - names, brands, sizes, barcodes, aliases - and the rules for matching a code to a product WITHOUT using AI.

**Shared.**

## What is here

| Path | What it does |
|---|---|
| `match/` | Resolver, alias matching, duplicate detection, server-side resolve |
| `catalog/` | Merging names/brands/sizes, prefix rules, evidence scoring, trust |
| `barcodes/` | GTIN checks, misread detection, the barcode trust gate |
| `tires/` | Tire sizes, part numbers, prefix hints |

## Before you change anything

A product is `known` ONLY from an approved alias or a verified product. A guess is never verified, and never becomes an alias without a human confirming it or app-checked evidence.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
