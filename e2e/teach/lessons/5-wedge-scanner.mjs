// e2e/teach/lessons/5-wedge-scanner.mjs
//
// Level 5: hardware keyboard-wedge barcode scanner simulation. A real wedge
// scanner types each character as a keypress then sends a terminator key
// (Enter, sometimes Tab). This lesson proves continuous scanning works:
// one row per scan, focus returns to '#scanner-input' after submit, an
// alternate terminator (Tab) does not break capture or trigger anything
// dangerous, losing focus does not permanently break capture, and a
// partial/interrupted scan still ends up on the feed per the top-level law.

export default {
  id: 'wedge-scanner',
  title: 'Keyboard-wedge scanner capture, refocus, and continuous scanning',
  level: 5,
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

    if (!knownCodes || knownCodes.length < 1) {
      findings.push(triage.buildFinding({
        title: 'Persona has no known codes for wedge-scanner lesson',
        category: 'test_data',
        severity: 'medium',
        lesson: 'wedge-scanner',
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

    // --- (a) wedge scan with Enter terminator: one new row, refocus after submit ---
    let refocusAfterSubmit = false;
    try {
      const before = await h.feedCount(page);
      await h.scan(page, code, { wedge: true, suffix: 'Enter' });
      const after = await h.waitFeedAtLeast(page, before + 1, 15000);

      if (after !== before + 1) {
        findings.push(triage.buildFinding({
          title: 'Wedge scan (Enter) did not create exactly one new feed row',
          category: 'scanner_flow',
          severity: 'high',
          lesson: 'wedge-scanner',
          persona: persona?.key ?? null,
          repro: `Simulate a keyboard-wedge scan of ${code} with Enter terminator.`,
          expected: `Feed count grows by exactly 1 (from ${before} to ${before + 1}).`,
          actual: `Feed count became ${after}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Continuous scanning with a real hardware scanner would miscount rows during a busy count session.',
          locked: true,
        }));
        pass = false;
      }

      const activeId = await page.evaluate(() => document.activeElement && document.activeElement.id).catch(() => null);
      refocusAfterSubmit = activeId === 'scanner-input';
      if (!refocusAfterSubmit) {
        findings.push(triage.buildFinding({
          title: 'Scan input did not regain focus after a wedge scan submitted',
          category: 'scanner_flow',
          severity: 'high',
          lesson: 'wedge-scanner',
          persona: persona?.key ?? null,
          repro: `Simulate a keyboard-wedge scan of ${code} (Enter), then check document.activeElement.id.`,
          expected: "document.activeElement.id === 'scanner-input' immediately after submit.",
          actual: `document.activeElement.id was ${JSON.stringify(activeId)}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A clerk scanning continuously would have to click back into the input after every scan - breaks the core workflow.',
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during wedge scan (Enter) capture check',
        category: 'scanner_flow',
        severity: 'high',
        lesson: 'wedge-scanner',
        persona: persona?.key ?? null,
        repro: `Simulate a keyboard-wedge scan of ${code} (Enter terminator).`,
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Unknown - could not evaluate wedge capture.',
        locked: true,
      }));
      pass = false;
    }
    learned.refocusAfterSubmit = refocusAfterSubmit;

    // --- (b) wedge scan with Tab terminator: must not break capture or trigger anything dangerous ---
    let tabSuffixOk = false;
    try {
      const before = await h.feedCount(page);
      await h.scan(page, code, { wedge: true, suffix: 'Tab' });
      // Tab may move focus elsewhere by browser default; give the app a
      // moment to process the scan regardless of where focus lands.
      await page.waitForTimeout(500);
      const after = await h.feedCount(page);

      tabSuffixOk = after === before + 1;
      if (!tabSuffixOk) {
        findings.push(triage.buildFinding({
          title: 'Wedge scan with Tab terminator did not produce exactly one new row',
          category: 'scanner_flow',
          severity: 'high',
          lesson: 'wedge-scanner',
          persona: persona?.key ?? null,
          repro: `Simulate a keyboard-wedge scan of ${code} with Tab terminator (some hardware scanners are configured this way).`,
          expected: `Feed count grows by exactly 1 (from ${before} to ${before + 1}).`,
          actual: `Feed count became ${after}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A shop whose scanner is configured with a Tab suffix would lose or miscount scans, or Tab could focus a dangerous control.',
          locked: true,
        }));
        pass = false;
      }

      // Refocus onto the scan input so subsequent steps are not affected by
      // wherever Tab moved focus.
      await page.locator('#scanner-input').click().catch(() => {});
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during wedge scan (Tab) capture check',
        category: 'scanner_flow',
        severity: 'high',
        lesson: 'wedge-scanner',
        persona: persona?.key ?? null,
        repro: `Simulate a keyboard-wedge scan of ${code} (Tab terminator).`,
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Unknown - could not evaluate Tab-suffix wedge capture.',
        locked: true,
      }));
      pass = false;
    }
    learned.tabSuffixOk = tabSuffixOk;

    // --- (c) lost focus recovery: click a neutral element, then wedge-scan again ---
    try {
      const neutral = page.getByRole('heading').first();
      await neutral.click({ trial: false }).catch(async () => {
        // No heading available; click the body as a neutral target instead.
        await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
      });

      const before = await h.feedCount(page);
      await h.scan(page, code, { wedge: true, suffix: 'Enter' });
      const after = await h.waitFeedAtLeast(page, before + 1, 15000).catch(() => h.feedCount(page));

      if (after < before + 1) {
        findings.push(triage.buildFinding({
          title: 'A scan after losing focus (clicking a neutral element) did not create a new row',
          category: 'scanner_flow',
          severity: 'high',
          lesson: 'wedge-scanner',
          persona: persona?.key ?? null,
          repro: `Click a neutral page element to move focus off '#scanner-input', then simulate a wedge scan of ${code}.`,
          expected: `The app refocuses the scan input (directly or via the click() in the helper) and the scan still appears; feed count grows by >= 1.`,
          actual: `Feed count went from ${before} to ${after}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A clerk who clicks elsewhere mid-session (e.g. to check a count) would then have a scan silently swallowed.',
          locked: true,
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during lost-focus recovery check',
        category: 'scanner_flow',
        severity: 'medium',
        lesson: 'wedge-scanner',
        persona: persona?.key ?? null,
        repro: 'Click a neutral element, then simulate a wedge scan.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    // --- (d) partial scan: type a few chars without Enter, then press Enter separately ---
    try {
      const before = await h.feedCount(page);
      const input = page.locator('#scanner-input');
      await input.click();
      const partial = code.slice(0, Math.max(1, Math.min(3, code.length)));
      await input.pressSequentially(partial, { delay: 15 });
      await page.waitForTimeout(200);
      await input.press('Enter');

      const after = await h.waitFeedAtLeast(page, before + 1, 15000).catch(() => h.feedCount(page));

      if (after < before + 1) {
        findings.push(triage.buildFinding({
          title: 'A partial/interrupted scan (typed then Enter separately) did not appear on the feed',
          category: 'scanner_flow',
          severity: 'high',
          lesson: 'wedge-scanner',
          persona: persona?.key ?? null,
          repro: `Type the first ${partial.length} character(s) of ${code} into '#scanner-input', pause, then press Enter.`,
          expected: 'The submitted code (even partial/misread) still appears on the feed and counts, per the top-level scan law - it may route to Needs Review as unidentified, but it must appear.',
          actual: `Feed count went from ${before} to ${after}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A misread or interrupted physical scan (common with real hardware) would vanish instead of counting as an unidentified item - top-level law violation.',
          locked: true,
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error during partial-scan check',
        category: 'scanner_flow',
        severity: 'medium',
        lesson: 'wedge-scanner',
        persona: persona?.key ?? null,
        repro: 'Type a partial code, pause, then press Enter separately.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
