# Import

Bringing products in from a spreadsheet: read the file, guess the columns, preview, apply.

**Shared.**

## What is here

| Path | What it does |
|---|---|
| `universalFileReader.ts` | Reads CSV, TSV and XLSX |
| `columnIntelligence.ts` | Guesses which column is which |
| `universalImportPreview.ts` | What you see before committing anything |
| `importMappingMemory.ts` | Remembers your column mapping for next time |

## Before you change anything

Several suites here locate their fixtures by a path relative to the test file. If you move a test, move its fixture folder with it or it will fail with a confusing missing-file error.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
