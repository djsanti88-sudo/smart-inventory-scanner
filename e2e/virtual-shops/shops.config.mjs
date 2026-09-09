// e2e/virtual-shops/shops.config.mjs
//
// Single source of truth for the four Virtual Shops persona configs: name,
// fixture file paths, report directory, and behavior knobs (typo/double-scan/
// interrupt rates, session pattern). See
// docs/HISTORY.md records the retired virtual-shops design; this file is the current
// per-shop spec (goal, daily loop, data sources, success metrics).
//
// IMPORTANT: this file is config-only - no Playwright, no browser code, no
// filesystem writes. e2e/virtual-shops/drivers/rincon-tire.mjs and
// drivers/quickfix-auto.mjs (built independently, same wave) currently
// hardcode their own DEFAULT_FIXTURE/DEFAULT_REPORT_DIR constants rather than
// importing this file - the paths below are kept in exact sync with those
// constants on purpose, so nothing drifts. A future combined "run all 4
// shops" command (design doc task 10) is the intended first real importer of
// this file; until then it also serves as living documentation.
//
// All paths are repo-root-relative POSIX strings (forward slashes), matching
// the convention used throughout e2e/ and reports/.

export const VIRTUAL_SHOPS_PORT = 3500;

export const SHOPS = {
  'rincon-tire': {
    key: 'rincon-tire',
    label: 'Rincon Tire',
    description:
      'Disciplined tire shop, realistic ~800-SKU scale, careful low-error owner. The baseline ' +
      '"this works great when used correctly" case.',
    fixtures: {
      // { known: [{code,label,brand,model,size,groupKey,sizeMergeGroupMember,...}], unknown: [code,...] }
      inventory: 'e2e/virtual-shops/fixtures/rincon-tire.json',
      meta: 'e2e/virtual-shops/fixtures/rincon-tire.meta.json',
    },
    behavior: {
      typoRate: 0,
      doubleScanRate: 0,
      interruptRate: 0,
      scansPerDayRange: [30, 60],
      sessionPattern:
        'morning-stock-count (known tire barcodes) -> a few genuinely-unknown codes to Needs Review, ' +
        'resolved once -> end-of-day variance export. Repeats with a slowly growing inventory across days.',
    },
    successMetrics: [
      'activationTimeUnderThreshold',
      'sustainedScansPerMinuteNearWedgeSpeed',
      'zeroLostOrDuplicatedCounts',
      'sizeMergeCorrectness',
      'varianceReportNumericallyCorrect',
    ],
    driver: 'e2e/virtual-shops/drivers/rincon-tire.mjs',
    reportDir: 'reports/virtual-shops/rincon-tire',
  },

  'quickfix-auto': {
    key: 'quickfix-auto',
    label: 'QuickFix Auto',
    description:
      'Small repair shop, ~150 mixed non-tire items, sloppy scanner habits. The resilience case for ' +
      'ordinary human error at normal small-shop scale.',
    fixtures: {
      // { items: [{code,label,sku,category,brand,unitPrice,qtyOnHand}] }
      inventory: 'e2e/virtual-shops/fixtures/quickfix-auto.json',
      meta: 'e2e/virtual-shops/fixtures/quickfix-auto.meta.json',
      // Reference table only - see README.md "Known gaps". The current driver generates its own
      // seeded error pattern at runtime and does not read this file yet.
      errorInjection: 'e2e/virtual-shops/fixtures/quickfix-auto-error-injection.json',
    },
    behavior: {
      typoRate: 0.08,
      doubleScanRate: 0.1,
      interruptRate: 0.03,
      scansPerDayRange: [140, 160],
      sessionPattern:
        'mixed non-tire items scanned with injected typos, deliberate double-scans, and mid-scan ' +
        'interruptions (navigate away or reload mid-buffer, then resume). Different error seed per day.',
    },
    successMetrics: [
      'everyInjectedScanAppearsAndCounts',
      'doubleScansIncrementSameProductNeverDuplicateRow',
      'unresolvedTyposRouteToNeedsReviewWithHonestReason',
      'midScanInterruptRecoveryBufferNotCorrupted',
    ],
    driver: 'e2e/virtual-shops/drivers/quickfix-auto.mjs',
    reportDir: 'reports/virtual-shops/quickfix-auto',
  },

  'legacy-tires': {
    key: 'legacy-tires',
    label: 'Legacy Tires',
    description:
      'Chaos import + reconcile, the "we found you $X" demo. Proves the universal import + ' +
      'reconciliation flow turns a genuinely ugly legacy spreadsheet into an honest, defensible ' +
      'variance report.',
    fixtures: {
      // Ugly CSV generated via e2e/teach/sheets.mjs generateInventorySheet(level:5) + one injected
      // exact-duplicate row. Headers: PN, Make, Product, Junk Column, Tire Size, QOH, UPC, Item Name.
      spreadsheet: 'e2e/virtual-shops/fixtures/legacy-tires-level5.csv',
      // { perProduct: [{key,name,bookQuantity,physicalQuantity,unitsDelta,unitPrice,dollarDelta}],
      //   totalDollarVariance, narrative, duplicateRowAssumption }
      groundTruth: 'e2e/virtual-shops/fixtures/legacy-tires-ground-truth.json',
    },
    behavior: {
      typoRate: null, // not scan-error-driven; ugliness lives in the spreadsheet, not the scan session
      doubleScanRate: null,
      interruptRate: null,
      sessionPattern:
        'import one ugly legacy-style spreadsheet -> physical scan session matching the ground-truth ' +
        'scanPlan -> reconcile against the seeded book count -> assert the exact expected dollar variance.',
    },
    successMetrics: [
      'importNeverSilentlyDropsAnUnparseableRow',
      'reconciliationDollarVarianceMatchesSeededDiscrepancyExactly',
      'ambiguousFuzzyMatchesStayReviewOnlyNeverAutoApplied',
      'demoNarrativeReproducibleFromSameSeed',
    ],
    driver: null, // not yet built (design doc task 6, wave-3)
    reportDir: 'reports/virtual-shops/legacy-tires',
  },

  'night-shift': {
    key: 'night-shift',
    label: 'Night Shift',
    description:
      'Offline and retry resilience, the "can this be trusted to run unattended overnight" case. No ' +
      'tire-specific data needed - this shop is about the sync/reliability layer.',
    fixtures: {
      // { days: [{dayIndex, phases: [{phase,offline,scans|action,...}], expected:{...}}] }
      scanSequence: 'e2e/virtual-shops/fixtures/night-shift-scan-sequence.json',
    },
    behavior: {
      typoRate: 0,
      doubleScanRate: 0,
      interruptRate: 0,
      offlineBurstSize: 10,
      retryStormCount: 3,
      sessionPattern:
        'scan burst while offline -> page refresh mid-session (still offline) -> reconnect -> retry ' +
        'storm on the pending-sync queue (same ScanEvents retried repeatedly via the app\'s own retry path).',
    },
    successMetrics: [
      'zeroLostCountsAcrossOfflineRefreshRetryReconnect',
      'idempotencyHoldsUnderRetryStorm',
      'pendingQueueFullyDrainsOnReconnect',
      'uiHonestlyShowsSavedLocallyNotSyncedYetWhileOffline',
    ],
    driver: null, // not yet built (design doc task 7, wave-3)
    reportDir: 'reports/virtual-shops/night-shift',
  },
};

export const SHOP_KEYS = Object.keys(SHOPS);

/** Returns the config for `key`, or throws with the valid key list (never silently falls back to
 *  an arbitrary shop - a typo'd --shop flag should fail loudly, not run the wrong simulation). */
export function getShopConfig(key) {
  const config = SHOPS[key];
  if (!config) {
    throw new Error(`Unknown virtual shop key "${key}". Valid keys: ${SHOP_KEYS.join(', ')}`);
  }
  return config;
}
