// e2e/teach/lessons/1-signup-first-scan.mjs
//
// Level 1: the app is reachable and usable at all. The orchestrator has
// already driven signup (or, in demo_open mode, there is no signup) and
// landed the page on /scan before run() is invoked. This lesson only
// verifies the scan input is present and that a single known scan appears
// on the feed and is counted.

export default {
  id: 'signup-first-scan',
  title: 'Signup completes and the first scan is usable',
  level: 1,
  explore: false,
  prereqs: [],

  async run(ctx) {
    const { page, persona, h, triage, deploymentMode } = ctx;
    const findings = [];
    let pass = true;
    const learned = {};
    const notes = [];

    if (deploymentMode === 'demo_open') {
      notes.push('demo_open mode: signup was skipped (shared demo tenant); verifying the shared /scan surface directly.');
    }

    try {
      const inputVisible = await page.locator('#scanner-input').isVisible().catch(() => false);
      if (!inputVisible) {
        findings.push(triage.buildFinding({
          title: 'Scan input not visible after signup/landing on /scan',
          category: 'onboarding',
          severity: 'critical',
          lesson: 'signup-first-scan',
          persona: persona?.key ?? null,
          repro: 'Complete signup (or land in demo_open mode), navigate to /scan.',
          expected: '#scanner-input is visible and focusable immediately.',
          actual: '#scanner-input was not visible.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A new customer cannot scan anything after signing up - total loss of the core product.',
          locked: true,
        }));
        pass = false;
        return { pass, findings, learned, notes: notes.join(' ') };
      }
      learned.signupWorks = true;
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error checking scan input visibility',
        category: 'onboarding',
        severity: 'high',
        lesson: 'signup-first-scan',
        persona: persona?.key ?? null,
        repro: 'Land on /scan and query #scanner-input.',
        expected: 'No exception while checking visibility.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      pass = false;
      return { pass, findings, learned, notes: notes.join(' ') };
    }

    const knownCodes = Array.isArray(persona?.codes?.known) && persona.codes.known.length > 0
      ? persona.codes.known
      : null;

    if (!knownCodes) {
      findings.push(triage.buildFinding({
        title: 'Persona has no known codes to scan',
        category: 'test_data',
        severity: 'medium',
        lesson: 'signup-first-scan',
        persona: persona?.key ?? null,
        repro: 'Inspect persona.codes.known.',
        expected: 'At least one known code available for the first-scan check.',
        actual: 'persona.codes.known was empty or missing.',
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      pass = false;
      return { pass, findings, learned, notes: notes.join(' ') };
    }

    const firstCode = knownCodes[0];
    learned.firstCode = firstCode;

    try {
      await h.scan(page, firstCode);
      await h.waitFeedAtLeast(page, 1, 15000);
      const total = await h.countedTotal(page);
      if (total < 1) {
        findings.push(triage.buildFinding({
          title: 'First scan appeared on the feed but was not counted',
          category: 'ledger',
          severity: 'critical',
          lesson: 'signup-first-scan',
          persona: persona?.key ?? null,
          repro: `Scan known code ${firstCode} as the very first scan of a new session.`,
          expected: 'countedTotal >= 1 after the first scan.',
          actual: `countedTotal was ${total}.`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Scan 1 = count 1 is the top-level product law; a violation here is severe.',
          locked: true,
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'First scan did not appear on the feed within timeout',
        category: 'ledger',
        severity: 'critical',
        lesson: 'signup-first-scan',
        persona: persona?.key ?? null,
        repro: `Scan known code ${firstCode} immediately after landing on /scan.`,
        expected: 'The scan appears on the feed within 15s.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A brand-new customer whose first scan silently vanishes will assume the product is broken.',
        locked: true,
      }));
      pass = false;
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
