// e2e/teach/lessons/4-offline-reconnect.mjs
//
// Level 4: offline scanning + reconnect. Proves L1 (every scan appears and
// counts, even offline - optimistic state must not depend on the network)
// and L5 (idempotent sync - reconnecting must never double-count a scan
// that was already counted locally while offline).

export default {
  id: 'offline-reconnect',
  title: 'Offline scans count locally and never double-count on reconnect',
  level: 4,
  explore: false,
  prereqs: ['signup-first-scan'],

  async run(ctx) {
    const { page, persona, h, triage } = ctx;
    const findings = [];
    let pass = true;
    const learned = {};
    const notes = [];

    const knownCodes = Array.isArray(persona?.codes?.known) && persona.codes.known.length > 0
      ? persona.codes.known
      : null;

    if (!knownCodes) {
      findings.push(triage.buildFinding({
        title: 'Persona has no known codes for offline-reconnect lesson',
        category: 'test_data',
        severity: 'medium',
        lesson: 'offline-reconnect',
        persona: persona?.key ?? null,
        repro: 'Inspect persona.codes.known.',
        expected: 'At least one known code available.',
        actual: 'persona.codes.known was empty or missing.',
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    const code = knownCodes[0];
    learned.code = code;

    let feedBefore = 0;
    let countBefore = 0;
    try {
      feedBefore = await h.feedCount(page);
      countBefore = await h.countedTotal(page);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not read baseline feed/count before going offline',
        category: 'environment',
        severity: 'medium',
        lesson: 'offline-reconnect',
        persona: persona?.key ?? null,
        repro: 'Read feedCount()/countedTotal() before toggling offline.',
        expected: 'Baseline reads succeed.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let offlineSupported = true;
    try {
      await h.setOffline(page, true);
    } catch (err) {
      offlineSupported = false;
      findings.push(triage.buildFinding({
        title: 'Could not simulate offline mode',
        category: 'environment',
        severity: 'medium',
        lesson: 'offline-reconnect',
        persona: persona?.key ?? null,
        repro: 'page.context().setOffline(true).',
        expected: 'Offline simulation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate offline behavior.',
      }));
      notes.push('Offline simulation unavailable in this environment; lesson could not exercise the offline path.');
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let offlineScansCounted = true;
    try {
      await h.scan(page, code);
      await h.scan(page, code);
      await h.waitFeedAtLeast(page, feedBefore + 2, 15000);
    } catch (err) {
      offlineScansCounted = false;
      findings.push(triage.buildFinding({
        title: 'Scans made while offline did not appear on the feed',
        category: 'ledger',
        severity: 'critical',
        lesson: 'offline-reconnect',
        persona: persona?.key ?? null,
        repro: `Go offline, scan known code ${code} twice.`,
        expected: 'Both offline scans appear on the feed within 15s (optimistic state must not depend on network).',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A shop scanning inventory with a spotty connection would lose scans entirely - top-level law violation.',
        locked: true,
      }));
    }

    let countAfterOfflineScans = countBefore;
    if (offlineScansCounted) {
      try {
        countAfterOfflineScans = await h.countedTotal(page);
        if (countAfterOfflineScans < countBefore + 2) {
          offlineScansCounted = false;
          findings.push(triage.buildFinding({
            title: 'Offline scans appeared on the feed but were not counted',
            category: 'ledger',
            severity: 'critical',
            lesson: 'offline-reconnect',
            persona: persona?.key ?? null,
            repro: `Go offline, scan known code ${code} twice, read countedTotal().`,
            expected: `countedTotal >= ${countBefore + 2} (baseline ${countBefore} + 2 offline scans).`,
            actual: `countedTotal was ${countAfterOfflineScans}.`,
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: 'Scan 10 = count 10 is the top-level product law; offline scans must count exactly like online ones.',
            locked: true,
          }));
        }
      } catch (err) {
        offlineScansCounted = false;
        findings.push(triage.buildFinding({
          title: 'Error reading counted total after offline scans',
          category: 'ledger',
          severity: 'high',
          lesson: 'offline-reconnect',
          persona: persona?.key ?? null,
          repro: 'Read countedTotal() after two offline scans.',
          expected: 'No exception.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
      }
    }
    learned.offlineScansCounted = offlineScansCounted;
    if (!offlineScansCounted) pass = false;

    let pendingIndicatorVisible = false;
    try {
      pendingIndicatorVisible = await page.getByTestId('pending-warning').isVisible().catch(() => false);
      learned.pendingIndicatorVisible = pendingIndicatorVisible;
      notes.push(pendingIndicatorVisible
        ? 'Pending-sync indicator was visible while offline (expected UX affordance).'
        : 'No pending-sync indicator was visible while offline - noting, not failing (may render elsewhere or be delayed).');
    } catch {
      notes.push('Could not check pending-sync indicator visibility.');
    }

    try {
      await h.setOffline(page, false);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not restore online mode after offline test',
        category: 'environment',
        severity: 'medium',
        lesson: 'offline-reconnect',
        persona: persona?.key ?? null,
        repro: 'page.context().setOffline(false) after offline scans.',
        expected: 'Reconnect simulation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate reconnect behavior.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    // Poll up to ~10s for sync to settle, then assert the count did not
    // change from its pre-reconnect value (no double-count).
    let doubleCountedOnReconnect = false;
    try {
      const pollStart = Date.now();
      let countAfterReconnect = countAfterOfflineScans;
      while (Date.now() - pollStart < 10000) {
        countAfterReconnect = await h.countedTotal(page);
        await page.waitForTimeout(500);
      }
      countAfterReconnect = await h.countedTotal(page);

      if (countAfterReconnect !== countAfterOfflineScans) {
        doubleCountedOnReconnect = true;
        findings.push(triage.buildFinding({
          title: 'Reconnect changed the counted total after offline scans (double-count suspected)',
          category: 'ledger',
          severity: 'high',
          lesson: 'offline-reconnect',
          persona: persona?.key ?? null,
          repro: `Scan known code ${code} twice offline, reconnect, wait ~10s, compare countedTotal().`,
          expected: `countedTotal stays at ${countAfterOfflineScans} after reconnect (idempotent sync, no re-application).`,
          actual: `countedTotal became ${countAfterReconnect} after reconnect.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A shop reconnecting after a dead zone would see inflated stock counts - idempotency law violation.',
          locked: true,
        }));
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error verifying reconnect did not double-count',
        category: 'ledger',
        severity: 'medium',
        lesson: 'offline-reconnect',
        persona: persona?.key ?? null,
        repro: 'Poll countedTotal() for ~10s after reconnect.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }
    learned.doubleCountedOnReconnect = doubleCountedOnReconnect;
    if (doubleCountedOnReconnect) pass = false;

    let retryButtonNoted = false;
    try {
      retryButtonNoted = await page.getByTestId('retry-sync').isVisible().catch(() => false);
      if (retryButtonNoted) notes.push('A retry-sync affordance is present (visible during this run).');
    } catch {
      // non-fatal
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
