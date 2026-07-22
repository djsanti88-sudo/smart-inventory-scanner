# APP_EXPERT — learned knowledge of Scanbin (auto-maintained by Teach Bot)

> This file IS auto-updated by the orchestrator at run end (atomic write). Learned, revisable
> knowledge only. Never put sacred rules here — those live in LOCKED_REQUIREMENTS.md.

## Target
- Live app: https://inventory-lovat-six.vercel.app
- Auth: Firebase email/password. No email verification is enforced (fully automatable signup).

## Routes (verified from source)
- `/login` — sign in / sign up / reset (one page, mode toggles). testids: `login-email`,
  `login-password`, `login-button`, `login-error`, `login-google`, `forgot-password`, `sign-out`.
- `/business` — create + select a business. testids: `business-name`, `create-business`,
  `select-business-<businessId>`, `membership-list`.
- `/scan` — the scanner. testids: `scanner-input`, `scan-success`, `scan-status`,
  `scan-feed-body`, `feed-product-<id>`, `feed-barcode-<id>`, `final-count-body`, `qty-<productId>`,
  `finish-session`, `first-run-banner`, `auto-decode-status`, `ai-status`.
- `/review` — Needs Review. testids: `review-body`, `review-row-<cleanCode>`, `link-existing`,
  `open-create`, `create-save`, `ignore-review`, `approve-suggestion`.
- `/products` — products + Universal Import. testids: `universal-import-file`, `import-preview`,
  `import-headline`, `import-apply`, `import-summary`, `column-mapping`.
- `/reconcile` — Shop-Ware reconcile. testids: `reconcile-file`, `reconcile-run`, `reconcile-report`,
  `bucket-<bucket>`, `reconcile-delta`, `reconcile-export-csv`.
- `/settings` — testids: `setting-ai-enabled`, `clear-cache`.

## Decode ladder (observed read-only; do not modify — see L4)
- Order: `upcitemdb -> openfoodfacts -> goupc -> fetchv2 -> gpt` (GTIN-gated rungs skipped for
  non-GTIN codes). Free corpus/cache stages run before the ladder.
- Trace fields in the `/api/ai-lookup` POST response: `debug.ladderPath` (settled rung),
  `debug.ladderReasons` [{rung, reason}] (in order), `debug.gptLadderSkipReason`,
  `debug.corroborationPath`, `debug.cached`, `debug.missReasonCode`.

## Known codes (seed, resolve instantly)
049000028904 Coca-Cola · 848983012906 Falken · 885911484047 DeWalt · 850012345678 Vital Whey ·
6419440485331 Nokian. Vendor/unknown: X004DY7YUT (FNSKU), B00FLYWNYQ (ASIN), 4950-1122 (unregistered).

## Import fuzzy mapping (schema fields)
partNumber, brand, model, size, quantity, uom, barcode, name, category — synonyms + typo tolerance
+ content inference in `src/services/columnIntelligence.ts`. Reconcile is Shop-Ware CSV only.
