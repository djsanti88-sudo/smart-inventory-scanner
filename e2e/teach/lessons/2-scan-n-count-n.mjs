// e2e/teach/lessons/2-scan-n-count-n.mjs
//
// Level 2 - TOP-LEVEL LAW (Scan N = count N). Every scanned code - known,
// unknown, or vendor/blocked-shape - must appear on the feed AND contribute
// to the counted total, with NO exceptions.
//
// Ground truth (verified from source, not assumed):
//   - The feed is NOT deduped: scanning the same known product K times
//     produces K feed rows.
//   - The count ledger IS deduped: those same K scans collapse onto ONE
//     final-count-body row whose qty-<productId> reads K.
//   - Unknown/unidentified/vendor scans still get a feed row AND their own
//     final-count-body row (an "Unidentified item" placeholder product), so
//     they contribute to the qty-* sum too. There is no separate bucket and
//     no session-total testid - countedTotal() is the sum of every qty-*
//     cell across every product row, known or not.
//   - Vendor-style codes (X00/FNSKU/ASIN) are never deterministically
//     resolved as a public UPC/GTIN, but AI decode MAY confidently identify
//     them (shop-local alias) or leave them unidentified/in review - both
//     are correct outcomes. The only real vendor bug is a vendor code shown
//     as a VERIFIED public-barcode product with a wrong identity; that is
//     out of cheap-detection reach here, so this lesson only proves the
//     vendor scan appeared and counted, and records its resulting status.
//
// The true invariant this lesson proves: after scanning K codes, the DELTA
// in feed row count equals K, and the DELTA in the qty-* sum also equals K.
// Absolute numbers are never asserted because prior lessons in the same
// session may have already added scans.

export default {
  id: 'scan-n-count-n',
  title: 'Scan N codes results in N feed rows and N counted (top-level law)',
  level: 2,
  explore: false,
  prereqs: [],

  async run(ctx) {
    const { page, baseURL, persona, h, triage } = ctx;
    const findings = [];
    let pass = true;
    const learned = {};
    const notes = [];

    const known = Array.isArray(persona?.codes?.known) && persona.codes.known.length > 0
      ? persona.codes.known[0]
      : null;
    const unknown = Array.isArray(persona?.codes?.unknown) && persona.codes.unknown.length > 0
      ? persona.codes.unknown[0]
      : null;
    const vendor = Array.isArray(persona?.codes?.vendor) && persona.codes.vendor.length > 0
      ? persona.codes.vendor[0]
      : null;

    if (!known) {
      findings.push(triage.buildFinding({
        title: 'Persona has no known code to build the batch',
        category: 'test_data',
        severity: 'medium',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: 'Inspect persona.codes.known.',
        expected: 'At least one known code.',
        actual: 'persona.codes.known was empty or missing.',
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }
    if (!unknown) notes.push('persona had no unknown code; the unknown-scan step was skipped.');
    if (!vendor) notes.push('persona had no vendor code; the vendor-scan step was skipped.');

    try {
      await h.gotoApp(page, baseURL, '/scan');
      await page.locator('#scanner-input').waitFor({ state: 'visible', timeout: 15000 });
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not reach the scan screen',
        category: 'environment',
        severity: 'high',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/scan"); wait for #scanner-input.',
        expected: 'Scan screen loads with a focused/visible scanner input.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    // --- Baseline (prior lessons in this session may have already scanned) ---
    let baselineFeed = 0;
    let baselineQty = 0;
    try {
      baselineFeed = await h.feedCount(page);
      baselineQty = await h.countedTotal(page);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not read baseline feed/qty state',
        category: 'ledger',
        severity: 'high',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: 'Read feedCount() and countedTotal() before scanning.',
        expected: 'Baseline readable via DOM.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let scannedOk = true;
    const scanSafely = async (code, label) => {
      try {
        await h.scan(page, code);
        return true;
      } catch (err) {
        scannedOk = false;
        findings.push(triage.buildFinding({
          title: `Failed to submit scan for ${label} code ${code}`,
          category: 'scanner_input',
          severity: 'high',
          lesson: 'scan-n-count-n',
          persona: persona?.key ?? null,
          repro: `Scan code "${code}" via #scanner-input.`,
          expected: 'Scan submits without error.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A failed scan submission could mean a lost scan.',
        }));
        return false;
      }
    };

    // --- Step 1: same known product scanned 3 times -> dedup on the count side ---
    let countRowsBefore = 0;
    try {
      countRowsBefore = await page.locator('[data-testid="final-count-body"] > tr').count();
    } catch {
      countRowsBefore = -1;
    }

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await scanSafely(known, 'known (repeat)');
    }
    try {
      await h.waitFeedAtLeast(page, baselineFeed + 3, 20000);
    } catch {
      // fall through - the delta assertion below reports the gap precisely.
    }

    let feedAfterTriple = baselineFeed;
    let qtyAfterTriple = baselineQty;
    let countRowsAfter = countRowsBefore;
    try {
      feedAfterTriple = await h.feedCount(page);
      qtyAfterTriple = await h.countedTotal(page);
      countRowsAfter = await page.locator('[data-testid="final-count-body"] > tr').count();
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not read feed/qty/count-row state after the triple-scan',
        category: 'ledger',
        severity: 'high',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan known code ${known} three times, then read feedCount()/countedTotal()/final-count-body rows.`,
        expected: 'State readable via DOM.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      pass = false;
    }

    const feedDeltaTriple = feedAfterTriple - baselineFeed;
    const qtyDeltaTriple = qtyAfterTriple - baselineQty;
    const countRowDelta = countRowsBefore >= 0 ? countRowsAfter - countRowsBefore : null;

    learned.qtyAfterTriple = qtyDeltaTriple;

    if (feedDeltaTriple !== 3) {
      findings.push(triage.buildFinding({
        title: 'Scanning the same known product 3x did not add 3 feed rows',
        category: 'ledger',
        severity: 'critical',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan known code ${known} three times in a row, then diff feedCount() before/after.`,
        expected: 'feedCount delta === 3 (feed is never deduped - one row per scan event).',
        actual: `feedCount delta was ${feedDeltaTriple} (baseline ${baselineFeed}, after ${feedAfterTriple}).`,
        evidence: {},
        triageClass: scannedOk ? 'confirmed_app_bug' : 'probable_app_bug',
        customerImpact: 'Top-level product law violated: "scan 10 = count 10". A vanished scan means lost inventory data trust.',
        locked: true,
      }));
      pass = false;
    }

    if (qtyDeltaTriple !== 3) {
      findings.push(triage.buildFinding({
        title: 'Scanning the same known product 3x did not raise the counted qty by 3',
        category: 'ledger',
        severity: 'critical',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan known code ${known} three times in a row, then diff countedTotal() before/after.`,
        expected: 'countedTotal delta === 3 (dedup increments qty, it does not drop scans).',
        actual: `countedTotal delta was ${qtyDeltaTriple} (baseline ${baselineQty}, after ${qtyAfterTriple}).`,
        evidence: {},
        triageClass: scannedOk ? 'confirmed_app_bug' : 'probable_app_bug',
        customerImpact: 'Scans are being silently excluded from the count ledger.',
        locked: true,
      }));
      pass = false;
    }

    learned.sameProductDedup = countRowDelta === null ? null : countRowDelta === 1;
    if (countRowDelta !== null && countRowDelta !== 1) {
      findings.push(triage.buildFinding({
        title: 'Same known product scanned 3x created more than one count row (dedup failure)',
        category: 'ledger',
        severity: 'high',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan known code ${known} three times, then diff final-count-body row count before/after.`,
        expected: 'final-count-body row count delta === 1 (repeat scans of the same product increment one row, never create a duplicate).',
        actual: `final-count-body row count delta was ${countRowDelta}.`,
        evidence: {},
        triageClass: 'confirmed_app_bug',
        customerImpact: 'A duplicate product row for the same identity fragments inventory counts and confuses reconciliation.',
        locked: true,
      }));
      pass = false;
    }

    // --- Step 2: one unknown scan + one vendor scan - every scan counts ---
    let scansThisStep = 0;
    let feedBeforeStep2 = feedAfterTriple;
    let qtyBeforeStep2 = qtyAfterTriple;

    if (unknown) {
      const ok = await scanSafely(unknown, 'unknown');
      if (ok) {
        try {
          await h.waitFeedAtLeast(page, feedBeforeStep2 + 1, 20000);
        } catch {
          // handled by the delta check below
        }
        scansThisStep += 1;
        let feedNow = feedBeforeStep2;
        let qtyNow = qtyBeforeStep2;
        try {
          feedNow = await h.feedCount(page);
          qtyNow = await h.countedTotal(page);
        } catch (err) {
          findings.push(triage.buildFinding({
            title: 'Could not read feed/qty state after the unknown scan',
            category: 'ledger',
            severity: 'high',
            lesson: 'scan-n-count-n',
            persona: persona?.key ?? null,
            repro: `Scan unknown code ${unknown}, then read feedCount()/countedTotal().`,
            expected: 'State readable via DOM.',
            actual: String(err && err.message ? err.message : err),
            evidence: {},
            triageClass: 'environment_problem',
            customerImpact: 'Unknown - could not evaluate.',
          }));
          pass = false;
        }
        const feedDelta = feedNow - feedBeforeStep2;
        const qtyDelta = qtyNow - qtyBeforeStep2;
        learned.unidentifiedCounts = feedDelta === 1 && qtyDelta === 1;
        if (feedDelta !== 1 || qtyDelta !== 1) {
          findings.push(triage.buildFinding({
            title: 'TOP-LEVEL LAW VIOLATION: unknown scan did not appear and count',
            category: 'ledger',
            severity: 'critical',
            lesson: 'scan-n-count-n',
            persona: persona?.key ?? null,
            repro: `Scan unknown code ${unknown}, then diff feedCount()/countedTotal() before/after.`,
            expected: 'feedCount delta === 1 AND countedTotal delta === 1 (every scan appears and counts, including unidentified items).',
            actual: `feedCount delta was ${feedDelta}, countedTotal delta was ${qtyDelta}.`,
            evidence: {},
            triageClass: 'confirmed_app_bug',
            customerImpact: 'Top-level product law violated: "scan 10 = count 10". An unidentified scan silently vanished.',
            locked: true,
          }));
          pass = false;
        }
        feedBeforeStep2 = feedNow;
        qtyBeforeStep2 = qtyNow;
      }
    }

    let vendorStatus = 'not_tested';
    if (vendor) {
      const ok = await scanSafely(vendor, 'vendor-style');
      if (ok) {
        try {
          await h.waitFeedAtLeast(page, feedBeforeStep2 + 1, 20000);
        } catch {
          // handled by the delta check below
        }
        scansThisStep += 1;
        let feedNow = feedBeforeStep2;
        let qtyNow = qtyBeforeStep2;
        try {
          feedNow = await h.feedCount(page);
          qtyNow = await h.countedTotal(page);
        } catch (err) {
          findings.push(triage.buildFinding({
            title: 'Could not read feed/qty state after the vendor scan',
            category: 'ledger',
            severity: 'high',
            lesson: 'scan-n-count-n',
            persona: persona?.key ?? null,
            repro: `Scan vendor-style code ${vendor}, then read feedCount()/countedTotal().`,
            expected: 'State readable via DOM.',
            actual: String(err && err.message ? err.message : err),
            evidence: {},
            triageClass: 'environment_problem',
            customerImpact: 'Unknown - could not evaluate.',
          }));
          pass = false;
        }
        const feedDelta = feedNow - feedBeforeStep2;
        const qtyDelta = qtyNow - qtyBeforeStep2;
        if (feedDelta !== 1 || qtyDelta !== 1) {
          findings.push(triage.buildFinding({
            title: 'TOP-LEVEL LAW VIOLATION: vendor-style scan did not appear and count',
            category: 'ledger',
            severity: 'critical',
            lesson: 'scan-n-count-n',
            persona: persona?.key ?? null,
            repro: `Scan vendor-style code ${vendor}, then diff feedCount()/countedTotal() before/after.`,
            expected: 'feedCount delta === 1 AND countedTotal delta === 1 (every scan appears and counts, including vendor-style codes).',
            actual: `feedCount delta was ${feedDelta}, countedTotal delta was ${qtyDelta}.`,
            evidence: {},
            triageClass: 'confirmed_app_bug',
            customerImpact: 'Top-level product law violated: "scan 10 = count 10". A vendor-style scan silently vanished.',
            locked: true,
          }));
          pass = false;
        }

        // Record resulting status only - do not fail either way. Both
        // "identified" (AI decode / shop alias) and "in review" /
        // "unidentified" are correct outcomes for a vendor-style code.
        try {
          const row = h.reviewRow(page, vendor);
          const inReview = await row.isVisible().catch(() => false);
          const feedShowsVerified = await page
            .locator('[data-testid^="feed-product-"]')
            .filter({ hasText: vendor })
            .count()
            .catch(() => 0);
          if (inReview) {
            vendorStatus = 'review';
          } else if (feedShowsVerified > 0) {
            vendorStatus = 'identified';
          } else {
            vendorStatus = 'unidentified';
          }
        } catch (err) {
          vendorStatus = `unknown (error: ${String(err && err.message ? err.message : err)})`;
        }

        feedBeforeStep2 = feedNow;
        qtyBeforeStep2 = qtyNow;
      }
    }
    learned.vendorStatus = vendorStatus;

    // --- Final overall invariant: total feed delta === total qty delta === total scans ---
    const totalExpectedScans = 3 + scansThisStep;
    const totalFeedDelta = feedBeforeStep2 - baselineFeed;
    const totalQtyDelta = qtyBeforeStep2 - baselineQty;

    if (totalFeedDelta !== totalQtyDelta || totalFeedDelta !== totalExpectedScans) {
      findings.push(triage.buildFinding({
        title: 'TOP-LEVEL LAW VIOLATION: overall feed delta and counted-qty delta disagree with scans performed',
        category: 'ledger',
        severity: 'critical',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan ${totalExpectedScans} codes total in this lesson (3x known, then unknown/vendor if available), diffing feedCount()/countedTotal() from baseline.`,
        expected: `feedCount delta === countedTotal delta === ${totalExpectedScans} (scan N = count N).`,
        actual: `feedCount delta was ${totalFeedDelta}, countedTotal delta was ${totalQtyDelta}, expected ${totalExpectedScans}.`,
        evidence: {},
        triageClass: 'confirmed_app_bug',
        customerImpact: 'Top-level product law violated: "scan 10 = count 10".',
        locked: true,
      }));
      pass = false;
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
