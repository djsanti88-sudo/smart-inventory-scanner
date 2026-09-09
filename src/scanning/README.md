# Scanning

Capturing a scan from the barcode gun or the camera, and cleaning up the raw text. Nothing here decides what a code actually is.

**Frontend + Shared.**

## What is here

| Path | What it does |
|---|---|
| `ScannerInput.tsx` | The scan box. An uncontrolled DOM input, so fast scanner injection never drops characters |
| `LiveScanFeed.tsx` | The running list of scans |
| `camera/` | Phone-camera scanning |
| `clean/` | Strips invisible characters and builds normalized candidates. Runs on the server too |

## Before you change anything

**Every scan must appear and count.** The count happens BEFORE any decode or network call, and that ordering *is* the rule - there is no guard function to grep for. The counting itself lives in `src/inventory/`.

## Where the routes are

Pages and API endpoints stay under `src/app/`. Next.js resolves routes by folder location, so
route entry points cannot move; they call into this folder.
