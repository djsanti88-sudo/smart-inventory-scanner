// e2e/teach/lessons/13-reconcile-matrix.mjs
//
// Level 13: Reconcile must recognize the SAME real product across many
// different vendor export formats (Shop-Ware-clean, generic POS mashed
// description, tire-distributor abbreviated headers, QuickBooks-messy with
// junk rows, minimal PN+qty only, barcode-forward, tab-separated, XLSX, and
// two deliberately-unsupported PN headers) and classify every row into the
// correct reconcile bucket with the correct delta.
//
// Step 1 establishes OUR counted quantities via a base-catalog Universal
// Import (no scanning involved - matches the app's real "import sets counted
// quantity" contract). Step 2 builds one customer file per vendor format via
// reconcileScenarios.mjs's generator, each annotated with the reconcile
// outcome (bucket + delta) that SHOULD result. Step 3 drives /reconcile for
// every case and compares the rendered report against the expectation.
//
// Two unsupported-header formats (failing_pslashsn, failing_usnumber) are
// EXPECTED to reconcile-import-error today - if the app instead recognizes
// them, that's noted as a (welcome) improvement, not a defect. If the app
// still rejects them, that IS surfaced as a real header-synonym gap: a shop
// whose export uses a common part-number header the app doesn't recognize
// cannot reconcile at all.

import * as scen from '../reconcileScenarios.mjs';

const KNOWN_BUCKETS = [
  'agreement',
  'variance',
  'expected_not_counted',
  'ambiguous',
  'unmatched',
  'non_tire',
  'uom_review',
  'unparseable',
];

export default {
  id: 'reconcile-matrix',
  title: 'Reconcile matches same product across many vendor export formats',
  level: 13,
  explore: true,
  prereqs: [],

  async run(ctx) {
    const { page, persona, h, triage, artifactsDir, baseURL } = ctx;
    const findings = [];
    let pass = true;
    const learned = { perFormat: {} };
    const notes = [];

    // -------------------------------------------------------------------
    // Step 1: establish OUR counted quantities via base-catalog import.
    // -------------------------------------------------------------------
    let cat;
    try {
      cat = await scen.writeBaseCatalogCsv(artifactsDir);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not write the base catalog CSV for the reconcile matrix',
        category: 'test_data',
        severity: 'medium',
        lesson: 'reconcile-matrix',
        persona: persona?.key ?? null,
        repro: 'scen.writeBaseCatalogCsv(artifactsDir)',
        expected: 'File generation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    const catalogImported = await importBaseCatalog({ page, h, baseURL, catalogPath: cat.filePath, triage, persona, findings });
    learned.catalogImported = catalogImported;
    if (!catalogImported) {
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    // -------------------------------------------------------------------
    // Step 2: build the per-format reconcile file matrix.
    // -------------------------------------------------------------------
    let cases;
    try {
      cases = await scen.buildReconcileMatrix(artifactsDir);
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not build the reconcile vendor-format matrix',
        category: 'test_data',
        severity: 'medium',
        lesson: 'reconcile-matrix',
        persona: persona?.key ?? null,
        repro: 'scen.buildReconcileMatrix(artifactsDir)',
        expected: 'Matrix generation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let totalExpected = 0;
    let totalCorrect = 0;
    let headerGaps = 0;
    let matchingGaps = 0;

    for (const testCase of cases) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runOneCase({ testCase, page, h, baseURL, triage, persona, artifactsDir });
      findings.push(...result.findings);
      learned.perFormat[testCase.formatKey] = result.tally;
      totalExpected += result.tally.checked;
      totalCorrect += result.tally.correct;
      matchingGaps += result.tally.mismatches;
      if (testCase.expectFileError && result.tally.fileError) headerGaps += 1;
      if (result.hadFailure) pass = false;
    }

    if (matchingGaps > 0 || headerGaps > 0) pass = false;

    learned.totalExpected = totalExpected;
    learned.totalCorrect = totalCorrect;
    notes.push(
      `Reconcile matched ${totalCorrect}/${totalExpected} expected outcomes across ${cases.length} formats; ` +
      `${headerGaps} header-parse gaps; ${matchingGaps} matching gaps.`
    );

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};

// ---------------------------------------------------------------------------
// Step 1 helper
// ---------------------------------------------------------------------------

async function importBaseCatalog({ page, h, baseURL, catalogPath, triage, persona, findings }) {
  try {
    await h.gotoApp(page, baseURL, '/products');
  } catch (err) {
    findings.push(triage.buildFinding({
      title: 'Could not navigate to /products to establish the reconcile-matrix base catalog',
      category: 'navigation',
      severity: 'high',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: 'gotoApp(page, baseURL, "/products")',
      expected: 'Navigation succeeds.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'environment_problem',
      customerImpact: 'Unknown - could not evaluate.',
    }));
    return false;
  }

  try {
    await page.getByTestId('universal-import-file').setInputFiles(catalogPath);
    await page.getByTestId('import-preview').waitFor({ state: 'visible', timeout: 20000 });
  } catch (err) {
    findings.push(triage.buildFinding({
      title: 'Base catalog import failed - cannot test reconcile',
      category: 'import',
      severity: 'critical',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: `Upload ${catalogPath} via universal-import-file on /products, wait for import-preview.`,
      expected: 'import-preview becomes visible within 20s.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: 'A shop cannot establish a base counted inventory at all, so reconcile is untestable.',
      locked: true,
    }));
    return false;
  }

  const importErrorVisible = await page.getByTestId('import-error').isVisible({ timeout: 1000 }).catch(() => false);
  if (importErrorVisible) {
    findings.push(triage.buildFinding({
      title: 'Base catalog import failed - cannot test reconcile',
      category: 'import',
      severity: 'critical',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: `Upload ${catalogPath} (canonical headers incl. brand) via universal-import-file.`,
      expected: 'No import-error on a clean, canonical-header catalog file with a brand column.',
      actual: 'import-error was visible.',
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: 'A shop cannot establish a base counted inventory at all, so reconcile is untestable.',
      locked: true,
    }));
    return false;
  }

  let headlineText = '';
  try {
    const headline = page.getByTestId('import-headline');
    await headline.waitFor({ state: 'visible', timeout: 5000 });
    headlineText = (await headline.innerText()).trim();
    if (!/Matched \d+ of \d+/.test(headlineText)) {
      findings.push(triage.buildFinding({
        title: 'Import headline text does not match expected "Matched X of Y" pattern for the reconcile-matrix base catalog',
        category: 'import',
        severity: 'medium',
        lesson: 'reconcile-matrix',
        persona: persona?.key ?? null,
        repro: `Upload ${catalogPath}, read import-headline text.`,
        expected: 'Headline text matches /Matched \\d+ of \\d+/.',
        actual: `Headline text was: "${headlineText}"`,
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Confusing feedback about how many base-catalog rows were auto-matched.',
      }));
    }
  } catch (err) {
    findings.push(triage.buildFinding({
      title: 'Could not read import-headline text for the reconcile-matrix base catalog',
      category: 'import',
      severity: 'medium',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: 'Read [data-testid="import-headline"] after upload.',
      expected: 'Headline readable via DOM.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'environment_problem',
      customerImpact: 'Unknown - could not evaluate.',
    }));
  }

  try {
    await page.getByTestId('import-apply').click();
    await page.getByTestId('import-summary').waitFor({ state: 'visible', timeout: 15000 });
  } catch (err) {
    findings.push(triage.buildFinding({
      title: 'Base catalog import failed - cannot test reconcile',
      category: 'import',
      severity: 'critical',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: `Upload ${catalogPath}, click import-apply, wait for import-summary.`,
      expected: 'Apply completes and shows a summary.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: 'A shop cannot establish a base counted inventory at all, so reconcile is untestable.',
      locked: true,
    }));
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 3 helpers
// ---------------------------------------------------------------------------

async function readReconcileReport(page) {
  const rows = [];
  for (const bucket of KNOWN_BUCKETS) {
    // eslint-disable-next-line no-await-in-loop
    const section = page.getByTestId(`bucket-${bucket}`);
    // eslint-disable-next-line no-await-in-loop
    const visible = await section.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) continue;
    const bodyRows = section.locator('tbody tr');
    // eslint-disable-next-line no-await-in-loop
    const rowCount = await bodyRows.count().catch(() => 0);
    for (let i = 0; i < rowCount; i += 1) {
      const row = bodyRows.nth(i);
      const cells = row.locator('td');
      // eslint-disable-next-line no-await-in-loop
      const cellCount = await cells.count().catch(() => 0);
      const cellTexts = [];
      for (let c = 0; c < cellCount; c += 1) {
        // eslint-disable-next-line no-await-in-loop
        cellTexts.push((await cells.nth(c).innerText().catch(() => '')).trim());
      }
      // eslint-disable-next-line no-await-in-loop
      const deltaText = (await row.getByTestId('reconcile-delta').innerText().catch(() => '')).trim();
      rows.push({
        bucket,
        partNumbers: cellTexts[0] ?? '',
        brand: cellTexts[1] ?? '',
        model: cellTexts[2] ?? '',
        size: cellTexts[3] ?? '',
        delta: deltaText,
      });
    }
  }
  return rows;
}

function expectedDeltaText(delta) {
  if (delta === null || delta === undefined) return null;
  if (delta === 0) return '0';
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function deltaMatches(expectedText, actualText) {
  if (expectedText === null) return true; // no numeric delta expected for this bucket
  const norm = (t) => (t === '+0' || t === '-0' ? '0' : t);
  return norm(expectedText) === norm(actualText);
}

function findMatchingRow(reportRows, item) {
  const keyLower = String(item.key ?? '').toLowerCase();
  const byKey = reportRows.find((r) => keyLower && r.partNumbers.toLowerCase().includes(keyLower));
  if (byKey) return byKey;
  const brandLower = String(item.brand ?? '').toLowerCase();
  const modelLower = String(item.model ?? '').toLowerCase();
  const sizeLower = String(item.size ?? '').toLowerCase();
  return reportRows.find((r) => {
    const brandOk = !brandLower || r.brand.toLowerCase().includes(brandLower) || brandLower.includes(r.brand.toLowerCase());
    const modelOk = !modelLower || r.model.toLowerCase().includes(modelLower) || modelLower.includes(r.model.toLowerCase());
    const sizeOk = !sizeLower || (r.size || '').toLowerCase().includes(sizeLower) || sizeLower.includes((r.size || '').toLowerCase());
    return brandOk && modelOk && sizeOk;
  });
}

async function runOneCase({ testCase, page, h, baseURL, triage, persona, artifactsDir }) {
  const findings = [];
  const tally = { checked: 0, correct: 0, mismatches: 0, fileError: false };

  try {
    await h.gotoApp(page, baseURL, '/reconcile');
    await page.getByTestId('reconcile-file').setInputFiles(testCase.filePath);
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Could not upload the "${testCase.formatKey}" reconcile file`,
      category: 'reconcile-matching',
      severity: 'high',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: `Upload ${testCase.filePath} via reconcile-file on /reconcile.`,
      expected: 'File input accepts the file.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: `A shop exporting from a "${testCase.formatKey}"-shaped system could not even upload a reconcile file.`,
    }));
    return { findings, tally, hadFailure: true };
  }

  if (testCase.expectFileError) {
    let errorVisible = false;
    try {
      errorVisible = await page.getByTestId('reconcile-import-error').isVisible({ timeout: 5000 }).catch(() => false);
    } catch {
      errorVisible = false;
    }
    tally.fileError = errorVisible;

    if (errorVisible) {
      let errorText = '';
      try {
        errorText = (await page.getByTestId('reconcile-import-error').innerText().catch(() => '')).trim();
      } catch {
        errorText = '';
      }
      findings.push(triage.buildFinding({
        title: `Reconcile cannot read a customer file using the "${testCase.formatKey}" part-number header`,
        category: 'reconcile-headers',
        severity: 'medium',
        lesson: 'reconcile-matrix',
        persona: persona?.key ?? null,
        repro: `Upload a customer reconcile export whose part-number column is headed "${testCase.formatKey}"-style (see ${testCase.filePath}).`,
        expected: 'A customer export using this common header should parse',
        actual: errorText || 'reconcile-import-error was visible',
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: "Shops whose software exports this header can't reconcile at all",
        options: ['Broaden the reconcile CSV header synonyms to accept this column name'],
      }));
    } else {
      // eslint-disable-next-line no-console
      console.warn(`reconcile-matrix: format "${testCase.formatKey}" was expected to reconcile-import-error but parsed instead - improvement, not a defect.`);
    }
    return { findings, tally, hadFailure: false };
  }

  try {
    await page.getByTestId('reconcile-run').click();
    await page.getByTestId('reconcile-report').waitFor({ state: 'visible', timeout: 20000 });
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Reconcile report never appeared for the "${testCase.formatKey}" format`,
      category: 'reconcile-matching',
      severity: 'critical',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: `Upload ${testCase.filePath}, click reconcile-run on /reconcile.`,
      expected: 'reconcile-report becomes visible within 20s.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: `A shop exporting from a "${testCase.formatKey}"-shaped system could not reconcile at all.`,
      locked: true,
    }));
    return { findings, tally, hadFailure: true };
  }

  const screenshotPath = `${artifactsDir}/reconcile-matrix-${testCase.formatKey}.png`;
  try {
    await h.screenshot(page, screenshotPath);
  } catch {
    // Screenshot failure is not itself a defect - proceed without evidence.
  }

  let reportRows = [];
  try {
    reportRows = await readReconcileReport(page);
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Could not read the reconcile report for the "${testCase.formatKey}" format`,
      category: 'reconcile-matching',
      severity: 'medium',
      lesson: 'reconcile-matrix',
      persona: persona?.key ?? null,
      repro: `Upload ${testCase.filePath}, click reconcile-run, read the bucket-* tables.`,
      expected: 'Report rows are readable via DOM.',
      actual: String(err && err.message ? err.message : err),
      evidence: { screenshot: screenshotPath },
      triageClass: 'environment_problem',
      customerImpact: 'Unknown - could not evaluate.',
    }));
    return { findings, tally, hadFailure: true };
  }

  for (const item of testCase.expected) {
    tally.checked += 1;
    const match = findMatchingRow(reportRows, item);
    const expectedDelta = expectedDeltaText(item.delta);

    if (!match) {
      tally.mismatches += 1;
      findings.push(triage.buildFinding({
        title: `Expected reconcile row not found for "${item.key}" (${testCase.formatKey})`,
        category: 'reconcile-matching',
        severity: 'medium',
        lesson: 'reconcile-matrix',
        persona: persona?.key ?? null,
        repro: `Upload ${testCase.filePath} (format ${testCase.formatKey}), reconcile, look for a row matching brand="${item.brand}" model="${item.model}" size="${item.size}".`,
        expected: `bucket=${item.bucket} delta=${expectedDelta ?? 'n/a'}`,
        actual: 'No matching row found in any reconcile bucket.',
        evidence: { screenshot: screenshotPath },
        triageClass: 'probable_app_bug',
        customerImpact: `Improve fuzzy identity match for the ${testCase.formatKey} format.`,
        options: [`Improve fuzzy identity match for ${testCase.formatKey}`],
      }));
      continue;
    }

    const bucketOk = match.bucket === item.bucket;
    const deltaOk = deltaMatches(expectedDelta, match.delta);

    if (bucketOk && deltaOk) {
      tally.correct += 1;
    } else {
      tally.mismatches += 1;
      findings.push(triage.buildFinding({
        title: `Wrong reconcile outcome for "${item.key}" (${testCase.formatKey})`,
        category: 'reconcile-matching',
        severity: bucketOk ? 'medium' : 'high',
        lesson: 'reconcile-matrix',
        persona: persona?.key ?? null,
        repro: `Upload ${testCase.filePath} (format ${testCase.formatKey}), reconcile, inspect the row for "${item.key}".`,
        expected: `bucket=${item.bucket} delta=${expectedDelta ?? 'n/a'}`,
        actual: `bucket=${match.bucket} delta=${match.delta}`,
        evidence: { screenshot: screenshotPath },
        triageClass: 'probable_app_bug',
        customerImpact: bucketOk
          ? `Delta reported incorrectly for a ${testCase.formatKey} export - a shop would see a wrong variance amount.`
          : `Improve fuzzy identity match for the ${testCase.formatKey} format - a shop's item would land in the wrong reconcile bucket.`,
        options: [`Improve fuzzy identity match for ${testCase.formatKey}`],
      }));
    }
  }

  return { findings, tally, hadFailure: false };
}
