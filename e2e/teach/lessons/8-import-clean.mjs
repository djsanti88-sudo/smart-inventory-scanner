// e2e/teach/lessons/8-import-clean.mjs
//
// Level 8: Universal Import happy path. A clean, canonical-header CSV
// (sheets.generateInventorySheet level 1) must be auto-matched and applied
// through Universal Import on /products with zero manual mapping and zero
// import-error surfaced.

export default {
  id: 'import-clean',
  title: 'Universal Import auto-matches and applies a clean canonical CSV',
  level: 8,
  explore: false,
  prereqs: ['signup-first-scan'],

  async run(ctx) {
    const { page, persona, h, sheets, triage, artifactsDir } = ctx;
    const findings = [];
    let pass = true;
    const learned = {};
    const notes = [];

    let sheet;
    try {
      sheet = await sheets.generateInventorySheet({
        level: 1,
        outDir: artifactsDir,
        fileBase: `clean-${persona.key}`,
      });
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not generate the clean (level 1) inventory sheet',
        category: 'test_data',
        severity: 'medium',
        lesson: 'import-clean',
        persona: persona?.key ?? null,
        repro: 'sheets.generateInventorySheet({ level: 1 })',
        expected: 'Sheet generation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    try {
      await h.gotoApp(page, ctx.baseURL, '/products');
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not navigate to /products',
        category: 'navigation',
        severity: 'high',
        lesson: 'import-clean',
        persona: persona?.key ?? null,
        repro: 'gotoApp(page, baseURL, "/products")',
        expected: 'Navigation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    try {
      await page.getByTestId('universal-import-file').setInputFiles(sheet.filePath);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not upload the clean CSV through universal-import-file',
        category: 'import',
        severity: 'high',
        lesson: 'import-clean',
        persona: persona?.key ?? null,
        repro: `Upload ${sheet.filePath} via [data-testid="universal-import-file"] on /products.`,
        expected: 'File input accepts the CSV.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A shop could not even start importing their inventory.',
        locked: true,
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let previewAppeared = true;
    try {
      await page.getByTestId('import-preview').waitFor({ state: 'visible', timeout: 15000 });
    } catch (err) {
      previewAppeared = false;
      findings.push(triage.buildFinding({
        title: 'Import preview never appeared for a clean canonical CSV',
        category: 'import',
        severity: 'critical',
        lesson: 'import-clean',
        persona: persona?.key ?? null,
        repro: `Upload ${sheet.filePath} (clean canonical headers) via universal-import-file on /products.`,
        expected: 'import-preview becomes visible within 15s.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A shop with a perfectly clean export could not import their inventory at all.',
        locked: true,
      }));
    }
    learned.previewAppeared = previewAppeared;

    let headlineText = '';
    if (previewAppeared) {
      try {
        const headline = page.getByTestId('import-headline');
        await headline.waitFor({ state: 'visible', timeout: 5000 });
        headlineText = (await headline.innerText()).trim();
        learned.headline = headlineText;

        if (!/Matched \d+ of \d+/.test(headlineText)) {
          findings.push(triage.buildFinding({
            title: 'Import headline text does not match expected "Matched X of Y" pattern',
            category: 'import',
            severity: 'medium',
            lesson: 'import-clean',
            persona: persona?.key ?? null,
            repro: `Upload ${sheet.filePath}, read import-headline text.`,
            expected: 'Headline text matches /Matched \\d+ of \\d+/.',
            actual: `Headline text was: "${headlineText}"`,
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: 'Confusing feedback about how many rows were auto-matched.',
          }));
          pass = false;
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Could not read import-headline text',
          category: 'import',
          severity: 'medium',
          lesson: 'import-clean',
          persona: persona?.key ?? null,
          repro: 'Read [data-testid="import-headline"] after upload.',
          expected: 'Headline readable via DOM.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'environment_problem',
          customerImpact: 'Unknown - could not evaluate.',
        }));
        pass = false;
      }
    }

    let importErrorVisible = false;
    try {
      importErrorVisible = await page.getByTestId('import-error').isVisible({ timeout: 1000 }).catch(() => false);
    } catch {
      importErrorVisible = false;
    }
    if (importErrorVisible) {
      findings.push(triage.buildFinding({
        title: 'import-error surfaced on a clean canonical CSV',
        category: 'import',
        severity: 'critical',
        lesson: 'import-clean',
        persona: persona?.key ?? null,
        repro: `Upload ${sheet.filePath} (clean canonical headers) via universal-import-file.`,
        expected: 'No import-error on a clean, canonical-header file.',
        actual: 'import-error was visible.',
        evidence: {},
        triageClass: 'confirmed_app_bug',
        customerImpact: 'A shop with a clean export would be blocked from importing.',
        locked: true,
      }));
      pass = false;
    }

    let cleanImportApplied = false;
    if (previewAppeared && !importErrorVisible) {
      try {
        await page.getByTestId('import-apply').click();
        await page.getByTestId('import-summary').waitFor({ state: 'visible', timeout: 15000 });
        const summaryText = (await page.getByTestId('import-summary').innerText()).trim();
        learned.summary = summaryText;

        const appliedRowsMatch = summaryText.match(/(\d+)/);
        const appliedRows = appliedRowsMatch ? parseInt(appliedRowsMatch[1], 10) : 0;
        cleanImportApplied = appliedRows > 0;

        if (!cleanImportApplied) {
          findings.push(triage.buildFinding({
            title: 'Import summary did not show any applied rows for a clean CSV',
            category: 'import',
            severity: 'high',
            lesson: 'import-clean',
            persona: persona?.key ?? null,
            repro: `Upload ${sheet.filePath}, click import-apply, read import-summary.`,
            expected: 'import-summary shows applied rows > 0.',
            actual: `Summary text was: "${summaryText}"`,
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: 'A shop importing a clean inventory export would see nothing applied.',
            locked: true,
          }));
          pass = false;
        }
      } catch (err) {
        findings.push(triage.buildFinding({
          title: 'Applying the clean import failed',
          category: 'import',
          severity: 'high',
          lesson: 'import-clean',
          persona: persona?.key ?? null,
          repro: `Upload ${sheet.filePath}, click import-apply, wait for import-summary.`,
          expected: 'Apply completes and shows a summary.',
          actual: String(err && err.message ? err.message : err),
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A shop could preview but not actually apply a clean import.',
          locked: true,
        }));
        pass = false;
      }
    } else {
      notes.push('Skipped clicking import-apply because the preview never appeared or import-error was shown.');
    }
    learned.cleanImportApplied = cleanImportApplied;

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};
