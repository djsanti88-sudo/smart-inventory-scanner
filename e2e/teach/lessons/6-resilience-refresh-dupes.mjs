// e2e/teach/lessons/6-resilience-refresh-dupes.mjs
//
// Level 6 - touches SACRED LAW 5 (idempotency). Two checks:
//   1. A page refresh must never wipe the current session's scans/counts.
//   2. Rapidly re-scanning the same known code must increment the existing
//      product's quantity, never mint a duplicate product row.

export default {
  id: 'resilience-refresh-dupes',
  title: 'Refresh survives scan state; rapid duplicate scans increment quantity, not rows',
  level: 6,
  explore: false,
  prereqs: ['scan-n-count-n'],

  async run(ctx) {
    const { page, persona, h, triage } = ctx;
    const findings = [];
    let pass = true;
    const learned = { survivesRefresh: false, dupIncrements: false };
    const notes = [];

    const known = Array.isArray(persona?.codes?.known) && persona.codes.known.length > 0
      ? persona.codes.known[0]
      : null;

    if (!known) {
      findings.push(triage.buildFinding({
        title: 'Persona has no known code for the resilience lesson',
        category: 'test_data',
        severity: 'medium',
        lesson: 'resilience-refresh-dupes',
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

    let c1 = 0;
    let t1 = 0;

    try {
      await h.scan(page, known);
      await h.waitFeedAtLeast(page, 1, 15000);
      c1 = await h.feedCount(page);
      t1 = await h.countedTotal(page);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Baseline scan before refresh test failed',
        category: 'scanner_input',
        severity: 'high',
        lesson: 'resilience-refresh-dupes',
        persona: persona?.key ?? null,
        repro: `Scan known code ${known} once and read feed/counted totals.`,
        expected: 'Baseline scan succeeds and totals are readable.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Could not establish a baseline for the refresh-resilience check.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    // --- Refresh resilience ------------------------------------------------
    try {
      await page.reload();
      await page.locator('#scanner-input').waitFor({ state: 'visible', timeout: 15000 });

      const c2 = await h.feedCount(page);
      const t2 = await h.countedTotal(page);

      const survives = c2 === c1 && t2 === t1;
      learned.survivesRefresh = survives;

      if (!survives) {
        findings.push(triage.buildFinding({
          title: 'SACRED LAW 5 VIOLATION: page refresh lost or changed scan state',
          category: 'persistence',
          severity: 'high',
          lesson: 'resilience-refresh-dupes',
          persona: persona?.key ?? null,
          repro: `Scan ${known} once (feedCount=${c1}, countedTotal=${t1}), then reload the page.`,
          expected: `feedCount stays ${c1} and countedTotal stays ${t1} after refresh.`,
          actual: `feedCount=${c2}, countedTotal=${t2} after refresh.`,
          evidence: {},
          triageClass: 'confirmed_app_bug',
          customerImpact: 'An accidental refresh must never erase a customer\'s scan session - this is a core reliability guarantee.',
          locked: true,
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during page-refresh resilience check',
        category: 'persistence',
        severity: 'high',
        lesson: 'resilience-refresh-dupes',
        persona: persona?.key ?? null,
        repro: `Scan ${known}, then page.reload().`,
        expected: 'No exception while checking post-refresh state.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Refresh survival could not be verified - treat as unresolved risk.',
        locked: true,
      }));
      pass = false;
    }

    // --- Duplicate-scan idempotency (increments qty, never a new row) -----
    try {
      const rowsLocator = page.locator('[data-testid="final-count-body"] > tr');
      const rowCountBefore = await rowsLocator.count().catch(() => 0);
      const totalBefore = await h.countedTotal(page);

      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await h.scan(page, known, { delayMs: 5 });
      }
      // Let the ledger settle.
      await page.waitForTimeout(500);

      const rowCountAfter = await rowsLocator.count().catch(() => 0);
      const totalAfter = await h.countedTotal(page);

      const totalIncreasedByThree = totalAfter === totalBefore + 3;
      const noNewRows = rowCountAfter === rowCountBefore;
      learned.dupIncrements = totalIncreasedByThree && noNewRows;

      if (!totalIncreasedByThree) {
        findings.push(triage.buildFinding({
          title: 'Rapid duplicate scans did not increment counted total by the expected amount',
          category: 'ledger',
          severity: 'high',
          lesson: 'resilience-refresh-dupes',
          persona: persona?.key ?? null,
          repro: `Rapidly re-scan known code ${known} 3 times (delayMs=5).`,
          expected: `countedTotal increases by exactly 3 (from ${totalBefore} to ${totalBefore + 3}).`,
          actual: `countedTotal went from ${totalBefore} to ${totalAfter}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Rapid re-scans (a common real-world pattern) must count every scan exactly once each.',
        }));
        pass = false;
      }

      if (!noNewRows) {
        findings.push(triage.buildFinding({
          title: 'SACRED LAW 5 VIOLATION: duplicate scans created a new product row instead of incrementing quantity',
          category: 'ledger',
          severity: 'high',
          lesson: 'resilience-refresh-dupes',
          persona: persona?.key ?? null,
          repro: `Rapidly re-scan known code ${known} 3 times and compare final-count-body row counts before/after.`,
          expected: `final-count-body row count stays at ${rowCountBefore} (duplicates increment qty, not new rows).`,
          actual: `final-count-body row count went from ${rowCountBefore} to ${rowCountAfter}.`,
          evidence: {},
          triageClass: 'confirmed_app_bug',
          customerImpact: 'Duplicate product rows for the same item would corrupt the customer\'s inventory counts and reporting.',
          locked: true,
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during duplicate-scan idempotency check',
        category: 'ledger',
        severity: 'high',
        lesson: 'resilience-refresh-dupes',
        persona: persona?.key ?? null,
        repro: `Rapidly re-scan known code ${known} 3 times.`,
        expected: 'No exception while checking idempotency.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Idempotency under rapid duplicate scans could not be verified - treat as unresolved risk.',
        locked: true,
      }));
      pass = false;
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
