#!/usr/bin/env node
// One-off generator for the owner-facing folder READMEs created by the Project A reorganization.
// Kept in the repo so the wording can be regenerated/edited in one place rather than 16.
import { writeFileSync, mkdirSync } from "node:fs";

const F = {
  "src/scanning": {
    title: "Scanning",
    what: "Capturing a scan from the barcode gun or the camera, and cleaning up the raw text. Nothing here decides what a code actually is.",
    side: "Frontend + Shared",
    rows: [
      ["ScannerInput.tsx", "The scan box. An uncontrolled DOM input, so fast scanner injection never drops characters"],
      ["LiveScanFeed.tsx", "The running list of scans"],
      ["camera/", "Phone-camera scanning"],
      ["clean/", "Strips invisible characters and builds normalized candidates. Runs on the server too"],
    ],
    warn: "**Every scan must appear and count.** The count happens BEFORE any decode or network call, and that ordering *is* the rule - there is no guard function to grep for. The counting itself lives in `src/inventory/`.",
  },
  "src/inventory": {
    title: "Inventory & Counting",
    what: "The count ledger: the single place where a scan becomes a number.",
    side: "Shared (pure logic)",
    rows: [
      ["ledger.ts", "Applies a scan event exactly once. 95 lines. The most important file in the app"],
      ["replay.ts", "Rebuilds the counts from the scan feed, to prove they are right"],
      ["idempotency.ts", "Keys minted at scan time, so a retry never double-counts"],
      ["FinalCountTable.tsx", "What the customer actually sees"],
      ["cleanup/", "Removing junk counts, with undo"],
    ],
    warn: "Run `npm run test:ledger` after ANY change here. `ledger.ts` is small and correct - resist tidying it. Fixing a wrong scan MOVES the count; it never deletes it.",
  },
  "src/products": {
    title: "Products",
    what: "What a product is - names, brands, sizes, barcodes, aliases - and the rules for matching a code to a product WITHOUT using AI.",
    side: "Shared",
    rows: [
      ["match/", "Resolver, alias matching, duplicate detection, server-side resolve"],
      ["catalog/", "Merging names/brands/sizes, prefix rules, evidence scoring, trust"],
      ["barcodes/", "GTIN checks, misread detection, the barcode trust gate"],
      ["tires/", "Tire sizes, part numbers, prefix hints"],
    ],
    warn: "A product is `known` ONLY from an approved alias or a verified product. A guess is never verified, and never becomes an alias without a human confirming it or app-checked evidence.",
  },
  "src/decoding": {
    title: "Decoding",
    what: "Figuring out an unknown barcode: free lookups first, then ONE paid AI call - plus every spend cap and kill switch that guards it.",
    side: "Backend, with a small owner-facing panel",
    rows: [
      ["server/pipeline/", "The ladder. Stops at the first usable identity"],
      ["server/knowledge/", "The tire and retail barcode corpora (400MB+) and their loaders"],
      ["server/cache/", "Remembers positive answers, so you never pay for the same code twice"],
      ["limits/", "Daily and account caps, spend guard, circuit breaker, kill switch"],
      ["panel/", "The owner-facing readout"],
    ],
    warn: "The corpus loaders build file paths from `process.cwd()` SEGMENTS. TypeScript cannot check those, and a text search will not find them. If one goes stale, every test still passes and production silently falls through to PAID AI - that happened on 2026-07-09. After any move here run `npm run build` and confirm the corpus tests RAN rather than skipped.",
  },
  "src/review": {
    title: "Review",
    what: "The Needs Review queue: approving a guess, correcting a wrong product, and teaching the app an alias.",
    side: "Frontend + shared rules",
    rows: [
      ["NeedsReviewTable.tsx", "The queue"],
      ["SuggestedApprovalPanel.tsx", "Approve or edit a suggested identity"],
      ["reviewDecisionVersion.ts", "Stops a stale decision resurrecting an already-resolved row"],
    ],
    warn: "These are three DIFFERENT operations and must not be merged: confirming an identity creates an alias, editing metadata changes fields only, and reassigning transfers the count.",
  },
  "src/sessions": {
    title: "Sessions",
    what: "Starting, finishing, locking and reopening a counting session.",
    side: "Shared",
    rows: [
      ["auto/", "The automatic session window"],
      ["history/", "Past sessions and their counts"],
      ["lock/", "Owner PIN, and the guard on destructive actions"],
    ],
    warn: "Do not change the auto-session timing constants - seeded test data depends on them exactly as written.",
  },
  "src/import": {
    title: "Import",
    what: "Bringing products in from a spreadsheet: read the file, guess the columns, preview, apply.",
    side: "Shared",
    rows: [
      ["universalFileReader.ts", "Reads CSV, TSV and XLSX"],
      ["columnIntelligence.ts", "Guesses which column is which"],
      ["universalImportPreview.ts", "What you see before committing anything"],
      ["importMappingMemory.ts", "Remembers your column mapping for next time"],
    ],
    warn: "Several suites here locate their fixtures by a path relative to the test file. If you move a test, move its fixture folder with it or it will fail with a confusing missing-file error.",
  },
  "src/reconcile": {
    title: "Reconcile",
    what: "Comparing what you counted against what your shop software says you should have, and reporting the dollar difference.",
    side: "Shared",
    rows: [
      ["match/", "The matching engine"],
      ["adapters/", "Shop-Ware and generic file formats"],
      ["variance/", "The dollar-difference report"],
    ],
    warn: "This folder was already well organized before the reorganization - it is the shape the other folders were modelled on.",
  },
  "src/reports": {
    title: "Reports & Export",
    what: "Getting data back out: CSV exports, the variance and boss reports, and shareable report links.",
    side: "Shared + Backend",
    rows: [
      ["export/", "CSV and other formats, with prices masked by role"],
      ["variance/", "The reports themselves"],
    ],
    warn: "Export masks prices and costs by role. If you touch the export path, check the masking tests - a leak here shows one customer another shop's numbers.",
  },
  "src/sync-database": {
    title: "Sync & Database",
    what: "Saving counts on the device and pushing them to the cloud, including the offline queue and retry.",
    side: "Shared",
    rows: [
      ["cloud/", "Firestore read/write and the Firebase Admin SDK"],
      ["mock/", "The fake backend used in dev and tests"],
      ["queue/", "Pending items, batching, retry"],
      ["StoreHydrator.tsx", "Loads saved state back into the app on startup"],
    ],
    warn: "**If you ever leave Firebase, this is the folder that changes.** The storage identifiers (`sis-scan-v1`, IndexedDB `sis-persist`, object store `kv`) must never change casually - old saved data becomes invisible with no error and nothing to restore from.",
  },
  "src/admin": {
    title: "Admin",
    what: "Things only the platform owner can do: the shared master catalog and its review queue, disputes, prefix rules.",
    side: "Backend, with a little UI",
    rows: [["CatalogReviewTable.tsx", "The owner review queue"]],
    warn: "The server half deliberately stays in `src/server/catalog/`, behind the server boundary. KNOWN GAP: platform-owner logic is still embedded inside some customer-facing files (the scan feed, the export, display names). Untangling that is a separate, security-relevant project.",
  },
  "src/shared": {
    title: "Shared",
    what: "Small things genuinely used everywhere.",
    side: "Shared",
    rows: [
      ["privacy/", "Strips prices, names and emails before anything goes to an outside AI; also the API-key-safety guards"],
      ["telemetry/", "Logging and the audit trail"],
      ["text/", "String distance and display formatting"],
      ["net/", "Fetch with backoff"],
      ["benchmark/", "Decode benchmark analysis"],
    ],
    warn: "Keep this folder small and boring. If fewer than three folders import something, it is not shared - it belongs with its owner.",
  },
  "src/user-interface": {
    title: "User Interface",
    what: "Cross-app chrome and generic UI only.",
    side: "Frontend",
    rows: [
      ["shell/", "Nav, and the production-Firebase warning banner"],
      ["ui/", "Badges, image hover preview"],
    ],
    warn: "Feature components live WITH their feature (`src/scanning/`, `src/review/`, and so on). Only put something here if it is genuinely used across the whole app.",
  },
};

let n = 0;
for (const [dir, v] of Object.entries(F)) {
  const table = v.rows.map((r) => "| `" + r[0] + "` | " + r[1] + " |").join("\n");
  const body =
    "# " + v.title + "\n\n" + v.what + "\n\n**" + v.side + ".**\n\n" +
    "## What is here\n\n| Path | What it does |\n|---|---|\n" + table + "\n\n" +
    "## Before you change anything\n\n" + v.warn + "\n\n" +
    "## Where the routes are\n\n" +
    "Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so\n" +
    "route entry points cannot move; they call into this folder.\n";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/README.md", body);
  n++;
}
console.log("READMEs written: " + n);
