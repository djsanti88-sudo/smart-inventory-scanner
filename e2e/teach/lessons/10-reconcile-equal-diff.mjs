// e2e/teach/lessons/10-reconcile-equal-diff.mjs
//
// Level 10: /reconcile against a Shop-Ware-style CSV. Two scenarios in one
// persona session (no state reset available mid-lesson):
//
//   EQUAL    - scan exactly what the shopware CSV expects; every bucket
//              should agree, zero variance, every delta reads 0.
//   DIFFERENT - because we cannot reset counted state between scenarios, we
//              force a variance by uploading a shopware CSV whose expected
//              quantity for one already-scanned product differs from what
//              was actually counted, PLUS a synthetic "ghost SKU" product
//              that is never scanned at all (guaranteed expected_not_counted,
//              regardless of what the equal phase already counted).

export default {
  id: 'reconcile-equal-diff',
  title: 'Reconcile: equal quantities agree, differing quantities show variance',
  level: 10,
  explore: false,
  prereqs: ['signup-first-scan'],

  async run(ctx) {
    const { page, persona, h, sheets, triage, artifactsDir, baseURL } = ctx;
    const findings = [];
    let pass = true;
    const learned = {};
    const notes = [];

    // -------------------------------------------------------------------
    // Scenario 1: EQUAL
    // -------------------------------------------------------------------
    const plan = sheets.buildReconcilePlan(sheets.DEFAULT_PRODUCTS, { equal: true });

    // /reconcile has no scanner input - all scanning must happen on /scan
    // first, then navigate to /reconcile only to upload the CSV.
    try {
      await h.gotoApp(page, baseURL, '/scan');
      await page.locator('#scanner-input').waitFor({ state: 'visible', timeout: 15000 });
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not reach the scan screen to build the reconcile baseline',
        category: 'environment',
        severity: 'high',
        lesson: 'reconcile-equal-diff',
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

    let scanFailure = null;
    for (const entry of plan.scanPlan) {
      const code = entry.barcode || entry.partNumber;
      if (!code) continue;
      for (let i = 0; i < entry.times; i += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await h.scan(page, code);
        } catch (err) {
          scanFailure = { code, err };
          break;
        }
      }
      if (scanFailure) break;
    }

    if (scanFailure) {
      findings.push(triage.buildFinding({
        title: 'Failed to submit a scan while building the reconcile-equal baseline',
        category: 'scanner_input',
        severity: 'high',
        lesson: 'reconcile-equal-diff',
        persona: persona?.key ?? null,
        repro: `Scan code "${scanFailure.code}" via #scanner-input while building the equal reconcile scenario.`,
        expected: 'Scan submits without error.',
        actual: String(scanFailure.err && scanFailure.err.message ? scanFailure.err.message : scanFailure.err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'Could not build the reconcile test scenario - scan itself failed.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let csvEqual;
    try {
      csvEqual = await sheets.generateShopwareCsv({
        outDir: artifactsDir,
        fileBase: `recon-eq-${persona.key}`,
        quantityOverride: plan.shopwareQuantities,
      });
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not generate the equal-scenario Shop-Ware CSV',
        category: 'test_data',
        severity: 'medium',
        lesson: 'reconcile-equal-diff',
        persona: persona?.key ?? null,
        repro: 'sheets.generateShopwareCsv({ quantityOverride: plan.shopwareQuantities })',
        expected: 'CSV generation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    const equalResult = await runReconcileUpload({
      page, h, baseURL, csvPath: csvEqual.filePath, triage, lesson: 'reconcile-equal-diff', persona, scenario: 'equal',
    });
    findings.push(...equalResult.findings);
    if (!equalResult.reportAppeared) {
      learned.equalAgreement = false;
      learned.variancePresent = null;
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let equalAgreement = true;
    try {
      const agreementVisible = await page.getByTestId('bucket-agreement').isVisible({ timeout: 5000 }).catch(() => false);
      const varianceCount = await page.getByTestId('bucket-variance').count().catch(() => -1);
      const deltaNodes = page.getByTestId('reconcile-delta');
      const deltaCount = await deltaNodes.count().catch(() => 0);
      let allDeltasZero = true;
      for (let i = 0; i < deltaCount; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const text = (await deltaNodes.nth(i).innerText().catch(() => '')).trim();
        if (text !== '0' && text !== '+0') allDeltasZero = false;
      }

      equalAgreement = agreementVisible && varianceCount === 0 && allDeltasZero;

      if (!equalAgreement) {
        findings.push(triage.buildFinding({
          title: 'Reconcile showed a variance when scanned quantities exactly matched the Shop-Ware CSV',
          category: 'reconcile',
          severity: 'high',
          lesson: 'reconcile-equal-diff',
          persona: persona?.key ?? null,
          repro: `Scan each DEFAULT_PRODUCTS entry exactly its own quantity, then upload a shopware CSV with the same quantities to /reconcile.`,
          expected: 'bucket-agreement visible, bucket-variance count 0, every reconcile-delta reads 0.',
          actual: `agreementVisible=${agreementVisible}, varianceCount=${varianceCount}, allDeltasZero=${allDeltasZero}`,
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A shop whose counts exactly match their system of record would see a false variance alert.',
          locked: true,
        }));
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error verifying the equal-scenario reconcile buckets',
        category: 'reconcile',
        severity: 'medium',
        lesson: 'reconcile-equal-diff',
        persona: persona?.key ?? null,
        repro: 'Read bucket-agreement/bucket-variance/reconcile-delta after equal-scenario reconcile-run.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
      equalAgreement = false;
    }
    learned.equalAgreement = equalAgreement;
    if (!equalAgreement) pass = false;

    // -------------------------------------------------------------------
    // Scenario 2: DIFFERENT
    // -------------------------------------------------------------------
    // We cannot reset counted state between scenarios, so instead of
    // re-scanning a different quantity we force the mismatch on the
    // shopware side: one already-scanned product gets an inflated expected
    // quantity (guaranteed variance no matter what was already counted),
    // and a synthetic "ghost SKU" that is never scanned at all lands in
    // expected_not_counted (guaranteed, since it was never in any scan batch).
    notes.push('Diff scenario forces the mismatch via the shopware CSV (inflated expected qty + a never-scanned ghost SKU) because resetting counted state mid-lesson was not available.');

    const varianceProduct = sheets.DEFAULT_PRODUCTS[0];
    const varianceKey = varianceProduct.partNumber || varianceProduct.barcode || varianceProduct.name;
    const ghostProduct = {
      partNumber: `TEACHBOT-GHOST-${persona.key}`,
      brand: 'TeachBot',
      model: 'Ghost SKU',
      size: '',
      barcode: '',
      name: 'TeachBot Ghost SKU (never scanned, expected_not_counted probe)',
      quantity: 3,
    };
    const diffProducts = [...sheets.DEFAULT_PRODUCTS, ghostProduct];
    const quantityOverride = {
      [varianceKey]: Number(varianceProduct.quantity ?? 0) + 3,
    };

    let csvDiff;
    try {
      csvDiff = await sheets.generateShopwareCsv({
        products: diffProducts,
        outDir: artifactsDir,
        fileBase: `recon-diff-${persona.key}`,
        quantityOverride,
      });
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Could not generate the different-scenario Shop-Ware CSV',
        category: 'test_data',
        severity: 'medium',
        lesson: 'reconcile-equal-diff',
        persona: persona?.key ?? null,
        repro: 'sheets.generateShopwareCsv({ products: diffProducts, quantityOverride })',
        expected: 'CSV generation succeeds.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'test_data_problem',
        customerImpact: 'None - test data gap, not an app defect.',
      }));
      learned.variancePresent = null;
      return { pass, findings, learned, notes: notes.join(' ') };
    }

    const diffResult = await runReconcileUpload({
      page, h, baseURL, csvPath: csvDiff.filePath, triage, lesson: 'reconcile-equal-diff', persona, scenario: 'different',
    });
    findings.push(...diffResult.findings);
    if (!diffResult.reportAppeared) {
      learned.variancePresent = false;
      return { pass: false, findings, learned, notes: notes.join(' ') };
    }

    let variancePresent = false;
    try {
      const varianceBucket = page.getByTestId('bucket-variance');
      variancePresent = await varianceBucket.isVisible({ timeout: 5000 }).catch(() => false);

      if (!variancePresent) {
        findings.push(triage.buildFinding({
          title: 'bucket-variance did not appear despite a forced quantity mismatch',
          category: 'reconcile',
          severity: 'high',
          lesson: 'reconcile-equal-diff',
          persona: persona?.key ?? null,
          repro: `Upload a shopware CSV where ${varianceKey}'s expected qty is inflated by 3 over what was actually counted.`,
          expected: 'bucket-variance is visible.',
          actual: 'bucket-variance was not visible.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A real quantity mismatch between counted stock and the system of record would go unreported.',
          locked: true,
        }));
      } else {
        const deltaNodes = page.getByTestId('reconcile-delta');
        const deltaCount = await deltaNodes.count().catch(() => 0);
        let sawSignedDelta = false;
        for (let i = 0; i < deltaCount; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const text = (await deltaNodes.nth(i).innerText().catch(() => '')).trim();
          if (/^[+-]\d+$/.test(text) && text !== '+0' && text !== '-0') sawSignedDelta = true;
        }
        if (!sawSignedDelta) {
          findings.push(triage.buildFinding({
            title: 'No signed (non-zero) reconcile-delta value found despite a forced variance',
            category: 'reconcile',
            severity: 'medium',
            lesson: 'reconcile-equal-diff',
            persona: persona?.key ?? null,
            repro: 'Read all reconcile-delta testids after uploading a shopware CSV with a forced quantity mismatch.',
            expected: 'At least one reconcile-delta reads a signed non-zero value (e.g. "+3" or "-3").',
            actual: 'No signed non-zero delta text was found.',
            evidence: {},
            triageClass: 'probable_app_bug',
            customerImpact: 'A shop could not tell by how much or in which direction their count differs from the system of record.',
          }));
        }
      }

      // The never-scanned ghost SKU must land in expected_not_counted, never in variance.
      const ghostLabel = ghostProduct.partNumber;
      const inExpectedNotCounted = await page
        .getByTestId('bucket-expected_not_counted')
        .filter({ hasText: ghostLabel })
        .count()
        .catch(() => 0);
      const inVariance = await page
        .getByTestId('bucket-variance')
        .filter({ hasText: ghostLabel })
        .count()
        .catch(() => 0);

      if (inExpectedNotCounted === 0) {
        findings.push(triage.buildFinding({
          title: 'A never-scanned SKU expected by Shop-Ware did not land in bucket-expected_not_counted',
          category: 'reconcile',
          severity: 'high',
          lesson: 'reconcile-equal-diff',
          persona: persona?.key ?? null,
          repro: `Upload a shopware CSV including ghost SKU "${ghostLabel}" (never scanned) and reconcile.`,
          expected: 'The never-scanned SKU appears in bucket-expected_not_counted.',
          actual: 'It did not appear there.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'A shop would not be told about stock their system of record expects but that was never physically counted.',
        }));
      }
      if (inVariance > 0) {
        findings.push(triage.buildFinding({
          title: 'A never-scanned SKU incorrectly appeared in bucket-variance instead of expected_not_counted',
          category: 'reconcile',
          severity: 'high',
          lesson: 'reconcile-equal-diff',
          persona: persona?.key ?? null,
          repro: `Upload a shopware CSV including ghost SKU "${ghostLabel}" (never scanned) and reconcile.`,
          expected: 'A zero-counted, expected SKU is classified as expected_not_counted, never variance.',
          actual: 'It appeared in bucket-variance.',
          evidence: {},
          triageClass: 'probable_app_bug',
          customerImpact: 'Misclassifying an uncounted item as a variance would mislead a shop about what actually differs.',
        }));
      }
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Error verifying the different-scenario reconcile buckets',
        category: 'reconcile',
        severity: 'medium',
        lesson: 'reconcile-equal-diff',
        persona: persona?.key ?? null,
        repro: 'Read bucket-variance/bucket-expected_not_counted/reconcile-delta after different-scenario reconcile-run.',
        expected: 'No exception.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'environment_problem',
        customerImpact: 'Unknown - could not evaluate.',
      }));
    }
    learned.variancePresent = variancePresent;
    if (!variancePresent) pass = false;

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};

async function runReconcileUpload({ page, h, baseURL, csvPath, triage, lesson, persona, scenario }) {
  const findings = [];
  try {
    await h.gotoApp(page, baseURL, '/reconcile');
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Could not navigate to /reconcile (${scenario} scenario)`,
      category: 'navigation',
      severity: 'high',
      lesson,
      persona: persona?.key ?? null,
      repro: 'gotoApp(page, baseURL, "/reconcile")',
      expected: 'Navigation succeeds.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'environment_problem',
      customerImpact: 'Unknown - could not evaluate.',
    }));
    return { reportAppeared: false, findings };
  }

  try {
    await page.getByTestId('reconcile-file').setInputFiles(csvPath);
    await page.getByTestId('reconcile-run').click();
    await page.getByTestId('reconcile-report').waitFor({ state: 'visible', timeout: 20000 });
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Reconcile report never appeared (${scenario} scenario)`,
      category: 'reconcile',
      severity: 'critical',
      lesson,
      persona: persona?.key ?? null,
      repro: `Upload ${csvPath} via reconcile-file, click reconcile-run on /reconcile.`,
      expected: 'reconcile-report becomes visible within 20s.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: 'A shop could not reconcile their counted inventory against their system of record at all.',
      locked: true,
    }));
    return { reportAppeared: false, findings };
  }

  return { reportAppeared: true, findings };
}
