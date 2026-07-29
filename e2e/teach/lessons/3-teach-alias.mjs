// e2e/teach/lessons/3-teach-alias.mjs
//
// Level 3: an unknown code routes to Needs Review, a human resolves it
// (create a new product, or link to an existing one), and that resolution
// is remembered - the next scan of the same code should resolve directly
// to a named product instead of showing as an Unidentified/unnamed row.

export default {
  id: 'teach-alias',
  title: 'Resolving an unknown code in Needs Review teaches a durable alias',
  level: 3,
  explore: false,
  prereqs: ['scan-n-count-n'],

  async run(ctx) {
    const { page, persona, baseURL, h, triage } = ctx;
    const findings = [];
    let pass = true;
    const learned = { aliasTaught: false };
    const notes = [];

    const unknown = Array.isArray(persona?.codes?.unknown) && persona.codes.unknown.length > 0
      ? persona.codes.unknown[0]
      : null;

    if (!unknown) {
      findings.push(triage.buildFinding({
        title: 'Persona has no unknown code to teach an alias for',
        category: 'test_data',
        severity: 'medium',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: 'Inspect persona.codes.unknown.',
        expected: 'At least one unknown code available.',
        actual: 'persona.codes.unknown was empty or missing.',
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    try {
      await h.scan(page, unknown);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Failed to submit the unknown code scan',
        category: 'scanner_input',
        severity: 'high',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: `Scan unknown code ${unknown}.`,
        expected: 'Scan submits without error.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A failed unknown-code scan blocks the teach-alias workflow entirely.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    try {
      await h.gotoApp(page, baseURL, '/review');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /review',
        category: 'navigation',
        severity: 'high',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: 'Navigate to /review after scanning an unknown code.',
        expected: 'The /review route loads.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    const row = h.reviewRow(page, unknown);
    const rowVisible = await row.isVisible().catch(() => false);

    if (!rowVisible) {
      findings.push(triage.buildFinding({
        title: 'Unknown code did not route to Needs Review',
        category: 'resolver_trust',
        severity: 'medium',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: `Scan unknown code ${unknown} then check /review for review-row-${unknown}.`,
        expected: 'An unresolved unknown code appears in Needs Review.',
        actual: 'No matching Needs Review row was found.',
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A customer cannot teach the app an alias for a code that never reaches Needs Review.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let resolved = false;
    try {
      const openCreate = row.getByTestId('open-create');
      const openCreateVisible = await openCreate.isVisible().catch(() => false);

      if (openCreateVisible) {
        await openCreate.click();
        const nameInput = page.getByLabel('product name');
        await nameInput.fill(`Teach Bot Test Product ${Date.now()}`);
        await page.getByTestId('create-save').click();
        resolved = true;
      } else {
        const linkExisting = row.getByTestId('link-existing');
        const linkVisible = await linkExisting.isVisible().catch(() => false);
        if (linkVisible) {
          await linkExisting.click();
          // Pick the first available option from whatever selection UI appears.
          const firstOption = page.locator('[role="option"], option, [data-testid^="link-option-"]').first();
          const optionVisible = await firstOption.isVisible().catch(() => false);
          if (optionVisible) {
            await firstOption.click();
          }
          const approve = page.getByTestId('approve-suggestion');
          if (await approve.isVisible().catch(() => false)) {
            await approve.click();
          }
          resolved = true;
        }
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error while resolving the unknown code in Needs Review',
        category: 'resolver_trust',
        severity: 'high',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: `From /review, resolve the row for unknown code ${unknown} via open-create or link-existing.`,
        expected: 'Resolution flow completes without exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A customer cannot successfully teach the app a new product identity.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    if (!resolved) {
      findings.push(triage.buildFinding({
        title: 'Neither open-create nor link-existing controls were available on the review row',
        category: 'resolver_trust',
        severity: 'high',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: `Open the Needs Review row for unknown code ${unknown}.`,
        expected: 'At least one resolution path (create or link) is visible on the row.',
        actual: 'Neither open-create nor link-existing were visible.',
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A customer would be stuck unable to resolve an unknown scan at all.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    // Re-scan the same code and confirm the feed now shows a named product
    // rather than an Unidentified/unnamed row - proof the alias was learned.
    try {
      await h.gotoApp(page, baseURL, '/scan');
      await page.locator('#scanner-input').waitFor({ state: 'visible', timeout: 15000 });
      await h.scan(page, unknown);
      await h.waitFeedAtLeast(page, 1, 15000);

      const namedProductRows = page.locator('[data-testid^="feed-product-"]');
      const namedCount = await namedProductRows.count().catch(() => 0);
      let sawNamedRow = false;
      for (let i = 0; i < namedCount; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const text = await namedProductRows.nth(i).innerText().catch(() => '');
        if (text && !/unidentified/i.test(text) && text.trim().length > 0) {
          sawNamedRow = true;
          break;
        }
      }

      learned.aliasTaught = sawNamedRow;

      if (!sawNamedRow) {
        findings.push(triage.buildFinding({
          title: 'Re-scanning a taught code still shows an unnamed/unidentified row',
          category: 'resolver_trust',
          severity: 'high',
          lesson: 'teach-alias',
          persona: persona?.key ?? null,
          repro: `Teach an alias for ${unknown}, then re-scan the same code.`,
          expected: 'The feed shows a named product row (the taught alias resolves deterministically).',
          actual: 'No named feed-product row was found after re-scanning.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Teaching an alias should permanently resolve future scans of the same code; if it does not, every scan requires manual re-resolution.',
        }));
        pass = false;
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error re-scanning the taught code to verify alias resolution',
        category: 'resolver_trust',
        severity: 'medium',
        lesson: 'teach-alias',
        persona: persona?.key ?? null,
        repro: `Re-scan ${unknown} after teaching an alias.`,
        expected: 'No exception while verifying.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      pass = false;
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
