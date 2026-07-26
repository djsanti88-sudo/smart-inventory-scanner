# APP_EXPERT — how Scanbin works (Teach Bot's learned map)

> Auto-maintained by the orchestrator (atomic write). Start every run from this file; append what you
> learn. NEVER put sacred rules here (those live in LOCKED_REQUIREMENTS.md) and never edit that file.

## Target + auth
- Live app: https://inventory-lovat-six.vercel.app. Firebase email/password; **no email verification** enforced.
- Modes: `live_auth` (real login + business membership + BusinessContextGate) vs `demo_open` (no login wall,
  shared demo tenant). Probe decides which.
- Role matrix (test BOTH when possible): **platformOwner** (allowlisted uid — sees technical/destructive
  controls) vs **customer** (most `isPlatform` controls are absent). On a fresh signup you are a customer.

## Signup / session flow
`/login` → toggle "Need an account? Sign up" (no testid; match by text) → fill `login-email` + `login-password`
→ `login-button` → lands on `/business` → fill `business-name` → `create-business` → click
`select-business-<id>` (dynamic) → `/scan` with `scanner-input` visible.

## Routes and their key controls (testid → what it does)
### /login
`login-email`, `login-password`, `login-button` (signin→/scan, signup→/business), `login-google`,
`forgot-password`→reset→`send-reset`, `login-error`, `login-notice`.

### /business
`sign-out` (drains store, honest unsynced warning, →/login), `membership-list` (loading/empty),
`select-business-<id>`, `business-name`, `create-business`, `business-error`.

### Top Nav (every app page)
Links by text: Scan, Products, Review (open-count badge), History, Reconcile, Settings. "Log out" only in
`live_auth`. `prod-firebase-banner` = dev-only non-interactive.

### /scan (gate may show: adopt-banner/adopt-data/skip-adopt, business-context-banner+go-to-business, business-loading)
- `scanner-input` (code + Enter or debounce; bulk paste splits). `scan-status`: "Ready to scan." / green
  `scan-success` (Added + qty) / "Looking up..." / amber conflict/new-code.
- `camera-scan-button`→`camera-scan-overlay`→`camera-scan-video`/`camera-denied-message`/`camera-unavailable-message`/`camera-scan-cancel`.
- Sessions `<details>`: new-session-name (aria), location (aria), `start-session`, `finish-session` (disabled if
  completed), Clear session (text, confirm), `session-lock`/`lock-session`/`unlock-open`/`unlock-pin`/`unlock-submit`/`unlock-error`.
- platformOwner chips: `auto-decode-status`, `ai-status`, `missing-keys`.
- `sessions-list` (>1 session): `session-item-<id>`, `open-session-<id>`, `view-session-<id>`→/sessions/<id>.
- `moat-line`, `first-run-banner` (non-interactive).

### SyncStatusBar (/scan + /review)
`online-status`, `pending-count`, `pending-warning`, `retry-sync` (disabled pending 0), `refresh-from-cloud`
(focus-safe), `toggle-offline` (isPlatform), `toggle-sync-failure` (isPlatform), `sync-error`.

### ExportMenu (/scan + /settings)
`export-menu-trigger`→`export-menu` (closes on outside/Escape). CSV buttons e.g. `export-final-counts`,
`export-qty-adjustments`, `export-unknowns`, `export-raw-log`(isPlatform), `export-pending`/`export-products`/
`export-aliases`(isPlatform); `<testid>-xlsx/-pdf/-html`; `export-error`. Import: `import-products`→hidden
`import-products-input`→`import-result`. Customers see far fewer datasets.

### LiveScanFeed
`scan-feed-body` ("No scans yet..."). Focus-safe `approve-suggestion-<eventId>`/`decline-suggestion-<eventId>`
(must NOT steal scanner focus). Cells `feed-barcode/brand/product/size/part-number/suggestion/off-category-<id>`.
"Raw code"/"Match"/"SKU" columns isPlatform.

### FinalCountTable
`polish-filter`, `final-count-body` ("No counts yet..."/"No products match this filter."). Rows `count-row-<id>`,
`qty-<id>`, `brand/model/size/count-barcode-<id>`. Actions `approve-discovered-<pid>-<code>`,
`correct-<pid>`→`correct-form-<pid>`→`correct-save-<pid>` (+`edit-unit-cost-<pid>` isPlatform),
`remove-count-<pid>` (confirm; PIN row `remove-pin-row-<pid>`/`remove-pin`/`remove-pin-confirm`/`remove-pin-error`),
`undo-delete-banner`/`undo-delete` (isPlatform). DEAD here (SHOW_ADVANCED_ACTIONS=false): `mark-wrong-<pid>`, `delete-product-<pid>`.

### VarianceReport
snapshot-label (aria), `save-count-snapshot`, `variance-empty-state`, `variance-from`, `variance-to`,
`export-variance-csv`, `variance-table`.

### /sessions/[id]
back link, `session-detail-name`, `export-session-timeline`, `session-timeline-table`/`timeline-row-<eventId>`.

### /review (tabs `review-tab-all`, `review-tab-suggested`)
NeedsReviewTable `review-body` ("Nothing to review..."). Row `review-row-<cleanCode>`; cells
`review-barcode/reason/score/blocking`, `decode-status`, isPlatform `evidence-strength`/`provider-results`/
`prefix-hint`/`prefix-conflict`/`reverse-upc-conflict`. Actions `approve-suggestion`, link select (aria
"link to product")+`link-existing`, `open-create`→`create-form`→`create-save`, `ignore-review`,
`live-decode`(isPlatform, hidden for import rows), `stronger-redecode`(isPlatform), `discovered-<code>`(isPlatform),
`mismatch-warning`/`mismatch-override`/`mismatch-cancel`, `alias-conflict`. SuggestedApprovalPanel:
`approve-selected`, `batch-approve-result`/`batch-approve-failed`, `suggested-select-all`,
`suggested-panel`/`suggested-body`, `suggested-checkbox-<code>`, `suggested-row-<code>`, `reject-suggestion-<code>`.

### /products
UniversalImportPanel (below). `products-body`, `product-row-<id>`. `image-link`→`image-hover-card`→`image-modal`.
isPlatform: `manage-codes-<pid>`→`codes-panel-<pid>`, `unlink-<code>`, move select (aria "move to product")+`move-<aliasId>`,
`delete-product-<pid>` (confirm+JSON backup+Undo), `undo-delete-banner`/`undo-delete`.

### UniversalImportPanel (/products, /scan, /settings)
`universal-import-panel`, `universal-import-file` (.csv/.tsv/.xlsx/.xls), `import-error`, `import-skipped-sheets`,
`column-mapping` (select aria "<Field> column"; `mapping-confirm`; `tier-<field>`), "Confirm and preview",
`import-preview`/`import-headline`, `import-apply`, `import-summary`.

### /reconcile (ReconcilePanel)
`reconcile-file`, `reconcile-import-error`, `reconcile-run`, `reconcile-match-error`, `reconcile-session-summary`,
`reconcile-empty-state`, `reconcile-no-report-yet`, `reconcile-report`, `reconcile-export-csv`,
`reconcile-assumptions`, `bucket-<variance|agreement|expected_not_counted|ambiguous|unmatched|non_tire|uom_review|unparseable>`,
`reconcile-delta`, `confirm-links`/`confirm-link-<code>`.

### /history
"No past sessions yet...", `history-current-session`, `history-session-<id>` (toggle), `history-detail-<id>`.

### /settings
OwnerPin `owner-pin-settings`/`pin-input`/`pin-save`/`pin-set-badge`/`pin-change`/`pin-reset` (confirm; also
unlocks all sessions)/`pin-msg`. AI (isPlatform): `setting-ai-enabled`, `setting-provider`, `setting-daily-limit`,
`setting-auto-suggest`, `setting-auto-add`, `setting-decode-budget`. Live AI status (isPlatform, mostly
non-interactive): `ai-mode`, `gemini-status`, `openai-status`, `gpt-ladder-status`, `last-failure`,
`emergency-stop`, `missing-keys-settings`, `refresh-ai-status`. Scanner (isPlatform): `setting-submit-mode`.
Account (all): `account-email`, `sign-out`, `account-local-mode`. Smart matching (isPlatform): `setting-auto-learning`,
`setting-auto-threshold`, `setting-scan-context` (any/tire — the ONLY live scan-context control),
`setting-trusted-source`, `setting-ai-only`. Catalog `catalog-status`. Cleanup `cleanup-review`→`cleanup-preview`,
`undo-cleanup`, `identifier-backfill`(isPlatform)/`backfill-apply`/`undo-backfill`, `cleanup-empty`,
`cleanup-group-<reason>`, `cleanup-item-<id>`, `cleanup-apply`, `cleanup-msg`. Danger zone (PIN-gated when a PIN
exists): `clear-cache` (confirm; PIN row `clear-cache-pin-row`/`clear-cache-pin`/`clear-cache-confirm`/`clear-cache-pin-error`;
wipes local + reloads), `clear-cache-message`, `delete-account`→`delete-account-form` (`delete-account-phrase`
== "DELETE MY ACCOUNT", `delete-account-pin` if set, `delete-account-confirm`, `delete-account-error`) —
IRREVERSIBLE, never in a smoke test.

### /report + /report/[token]
`print-report`, `share-report`→`share-url`/`share-error`, `boss-report-body` (`report-moat-line`,
`report-total-items`, `report-total-value`). Public token page read-only (`share-link-error` if expired).

## Cross-cutting rules for exercising controls (avoid false failures)
1. **Role matrix**: isPlatform-only controls are ABSENT for a customer — absence is correct, not a bug.
2. **PIN gate** (`requiresOwnerPin`, true when any PIN is set) shared by Remove-from-count, Clear-cache,
   Delete-account. Test no-PIN (immediate) and PIN-set (prompt→wrong error→right succeeds).
3. **Dialog-gated** (register a dialog handler first): Sign out, Clear session, Remove from count, Delete
   product, Clear cache, Delete account, PIN reset, Cleanup apply.
4. **Dead/hidden testids** (never in live DOM): `category-warning*`, `scan-category`, FinalCountTable
   `mark-wrong-*`/`delete-product-*`.
5. **Focus-safety**: after `approve-suggestion-*`/`decline-suggestion-*`/`refresh-from-cloud`, focus must stay on
   `#scanner-input`.
6. **File inputs** (setInputFiles): `import-products-input`, `universal-import-file`, `reconcile-file`.
7. **Never in a smoke pass on a real account**: `delete-account-confirm` (irreversible); `sign-out` (ends the
   reused session — last, if at all).

## Verified behavior semantics (ground truth - do NOT mis-assert these)
- **Feed vs count:** `scan-feed-body` gets ONE row per scan EVENT (no dedup). `final-count-body` DEDUPES by
  product: same code scanned N times => N feed rows but ONE count row with `qty-<id>` = N. N distinct codes =>
  N feed rows AND N count rows.
- **Unidentified/vendor scans STILL COUNT:** every scan (known/unknown/vendor) gets a feed row AND a
  `final-count-body` row with its own `qty-<id>` cell (an "Unidentified item" placeholder). So
  `sum of all [data-testid^="qty-"]` INCLUDES unidentified/vendor items. There is NO session-total testid.
- **TRUE "Scan N = count N":** `delta(feed rows) === delta(sum of qty-* cells) === codes scanned`. Assert
  DELTAS from a baseline, never hardcoded absolutes (prior lessons already added scans). Rescanning the same
  code does NOT add a count row - it increments that row's qty (dedup, L5).
- **Vendor codes (X00/FNSKU/B0 ASIN):** the deterministic resolver NEVER matches them as a public UPC/GTIN,
  but AI decode MAY confidently identify + auto-count one (shop-local approved alias, review auto-resolved)
  when it app-verifies the exact code in a trusted source. So a vendor code is NOT required to sit in Needs
  Review - it may be identified/counted OR reviewed; both are correct. The only vendor BUG is a vendor code
  shown as a VERIFIED public-UPC product with a wrong identity.
- **Universal import panel** is unconditionally on `/products` (`universal-import-panel`; heading "Universal
  inventory import"; button "Choose file") - no gating/delay. Detect with Playwright auto-waiting
  `expect(getByTestId('universal-import-panel')).toBeVisible()` after the route settles; do NOT assert absence
  from an immediate/early check. (`account-email` on /settings is likewise present for all roles.)

## Learned log (append newly-observed reality here, dated)
- 2026-07-22: prod is `live_auth`; signup + business-create + first scan work end-to-end. `/api/products` with a
  foreign businessId → 404; `/api/reconcile/match` with a foreign businessId → 200 (verify if tenant-scoped).
- 2026-07-22: corrected false-positive lesson assertions (see Verified behavior semantics above): the earlier
  "scan-n-count-n mismatch", "vendor must be in review", and "import-panel absent" findings were TEST bugs, not
  app bugs. Console/page errors observed on /products and /reconcile remain worth verifying.
