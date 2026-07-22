// e2e/teach/lessons/2-scan-n-count-n.mjs
//
// Level 2 - SACRED LAW 1 (Scan N = count N). Every scanned code - known,
// unknown, or vendor/blocked-shape - must appear on the feed and be counted,
// with NO exceptions. This lesson also checks LAW 3 (vendor-style codes must
// never be silently auto-verified) by way of the vendor code routing to
// Needs Review instead of showing as a verified product on the feed.

export default {
  id: 'scan-n-count-n',
  title: 'Scan N codes results in N feed rows and N counted (sacred law 1)',
  level: 2,
  explore: false,
  prereqs: ['signup-first-scan'],

  async run(ctx) {
    const { page, persona, h, triage } = ctx;
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

    // Build the 5-scan batch; fall back to known[0] for any missing bank entry.
    const batch = [known, known, known, unknown || known, vendor || known];
    if (!unknown) notes.push('persona had no unknown code; used known[0] as a fallback in the batch.');
    if (!vendor) notes.push('persona had no vendor code; used known[0] as a fallback in the batch.');
    learned.batchSize = batch.length;

    let scannedOk = true;
    for (const code of batch) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await h.scan(page, code);
      } catch (err) {
        scannedOk = false;
        findings.push(triage.buildFinding({
          title: `Failed to submit scan for code ${code}`,
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
      }
    }

    // Give the feed a moment to settle for the last scan.
    try {
      await h.waitFeedAtLeast(page, batch.length, 20000);
    } catch {
      // fall through - the exact-count assertion below reports the gap precisely.
    }

    let finalFeedCount = 0;
    try {
      finalFeedCount = await h.feedCount(page);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not read scan feed count',
        category: 'ledger',
        severity: 'high',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: 'Read [data-testid="scan-feed-body"] row count after scanning a 5-code batch.',
        expected: 'Feed count readable via DOM.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    learned.allCounted = finalFeedCount === batch.length;

    if (finalFeedCount !== batch.length) {
      findings.push(triage.buildFinding({
        title: 'SACRED LAW 1 VIOLATION: scanned code count does not match feed row count',
        category: 'ledger',
        severity: 'critical',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan this exact batch in order: ${JSON.stringify(batch)}. Then read scan-feed-body row count.`,
        expected: `feedCount === ${batch.length} (every scan appears - no exceptions).`,
        actual: `feedCount was ${finalFeedCount}.`,
        evidence: {},
        triageClass: scannedOk ? 'confirmed_app_bug' : 'probable_app_bug',
        customerImpact: 'Top-level product law violated: "scan 10 = count 10". A vanished scan means lost inventory data trust.',
        locked: true,
      }));
      pass = false;
    }

    let countedTotal = 0;
    try {
      countedTotal = await h.countedTotal(page);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not read counted total',
        category: 'ledger',
        severity: 'high',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: 'Sum qty-* testids after scanning a 5-code batch.',
        expected: 'Counted total readable via DOM.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      pass = false;
      countedTotal = -1;
    }

    if (countedTotal >= 0 && countedTotal < batch.length) {
      findings.push(triage.buildFinding({
        title: 'SACRED LAW 1 VIOLATION: counted total is less than scans performed',
        category: 'ledger',
        severity: 'critical',
        lesson: 'scan-n-count-n',
        persona: persona?.key ?? null,
        repro: `Scan this exact batch in order: ${JSON.stringify(batch)}. Then sum all qty-* testids.`,
        expected: `countedTotal >= ${batch.length} ("scan 10 = count 10" - unidentified rows count too).`,
        actual: `countedTotal was ${countedTotal}.`,
        evidence: {},
        triageClass: 'confirmed_app_bug',
        customerImpact: 'Scans are being silently excluded from the count ledger.',
        locked: true,
      }));
      pass = false;
    }

    // Vendor-style code must route to Needs Review, never auto-verify.
    if (vendor) {
      try {
        const row = h.reviewRow(page, vendor);
        const visible = await row.isVisible().catch(() => false);
        if (!visible) {
          findings.push(triage.buildFinding({
            title: 'Vendor-style code did not route to Needs Review',
            category: 'resolver_trust',
            severity: 'high',
            lesson: 'scan-n-count-n',
            persona: persona?.key ?? null,
            repro: `Scan vendor-style code ${vendor}, then check /review for review-row-${vendor}.`,
            expected: 'Vendor/X00/FNSKU-shaped codes always route to Needs Review absent a human-approved alias.',
            actual: 'No matching Needs Review row was found.',
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: 'A vendor label could be silently and wrongly treated as a real product identity.',
          }));
          pass = false;
        } else {
          // Also confirm it did NOT show as a verified product on the feed
          // (a feed-product-* row implies a resolved/verified identity).
          const feedShowsVerified = await page
            .locator('[data-testid^="feed-product-"]')
            .filter({ hasText: vendor })
            .count()
            .catch(() => 0);
          if (feedShowsVerified > 0) {
            findings.push(triage.buildFinding({
              title: 'LAW 3 VIOLATION: vendor-style code auto-verified as a product on the feed',
              category: 'resolver_trust',
              severity: 'critical',
              lesson: 'scan-n-count-n',
              persona: persona?.key ?? null,
              repro: `Scan vendor-style code ${vendor}; check the feed for a feed-product-* row referencing it.`,
              expected: 'Vendor-style codes never auto-verify as a known product identity.',
              actual: 'Feed showed a verified product row for the vendor-style code.',
              evidence: {},
              triageClass: 'confirmed_app_bug',
              customerImpact: 'Wrong product identity is worse than unknown - this is the resolver trust rule violated.',
              locked: true,
            }));
            pass = false;
          }
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Error checking vendor-code review routing',
          category: 'resolver_trust',
          severity: 'medium',
          lesson: 'scan-n-count-n',
          persona: persona?.key ?? null,
          repro: `Scan vendor-style code ${vendor} then inspect review/feed rows.`,
          expected: 'No exception while checking routing.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }
    } else {
      notes.push('no vendor code available for this persona; vendor-routing check skipped.');
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
