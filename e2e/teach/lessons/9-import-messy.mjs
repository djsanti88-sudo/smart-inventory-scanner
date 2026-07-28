// e2e/teach/lessons/9-import-messy.mjs
//
// Level 9: Universal Import fuzzy mapper against increasingly messy real-world
// exports (levels 2-5: renamed/shuffled headers, alternate delimiters, XLSX,
// junk rows/columns + typos). The fuzzy mapper must understand each format
// well enough to surface either an auto-matched preview or a low-confidence
// manual column-mapping UI - it must never hard-error on a merely messy (not
// corrupt) file. Only level 2 is actually applied, to avoid polluting counts
// with repeated apply clicks across every messiness level.

const MESSY_LEVELS = [2, 3, 4, 5];

export default {
  id: 'import-messy',
  title: 'Universal Import fuzzy mapper handles messy real-world export formats',
  level: 9,
  explore: false,
  prereqs: ['import-clean'],

  async run(ctx) {
    const { page, persona, h, sheets, triage, artifactsDir } = ctx;
    const findings = [];
    let pass = true;
    const learned = { perLevel: {} };
    const notes = [];

    for (const level of MESSY_LEVELS) {
      // eslint-disable-next-line no-await-in-loop
      const levelResult = await runOneLevel({ level, page, persona, h, sheets, triage, artifactsDir, baseURL: ctx.baseURL });
      learned.perLevel[level] = levelResult.mapped;
      findings.push(...levelResult.findings);
      if (levelResult.note) notes.push(levelResult.note);
      if (!levelResult.mapped) pass = false;
    }

    return { pass, findings, learned, notes: notes.join(' ') };
  },
};

async function runOneLevel({ level, page, persona, h, sheets, triage, artifactsDir, baseURL }) {
  const findings = [];
  let note = null;

  let sheet;
  try {
    sheet = await sheets.generateInventorySheet({
      level,
      outDir: artifactsDir,
      fileBase: `messy-L${level}-${persona.key}`,
    });
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Could not generate the level ${level} messy inventory sheet`,
      category: 'test_data',
      severity: 'medium',
      lesson: 'import-messy',
      persona: persona?.key ?? null,
      repro: `sheets.generateInventorySheet({ level: ${level} })`,
      expected: 'Sheet generation succeeds.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'test_data_problem',
      customerImpact: 'None - test data gap, not an app defect.',
    }));
    return { mapped: false, findings, note: `level ${level} sheet generation failed` };
  }

  try {
    await h.gotoApp(page, baseURL, '/products');
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Could not navigate to /products for level ${level} messy import`,
      category: 'navigation',
      severity: 'high',
      lesson: 'import-messy',
      persona: persona?.key ?? null,
      repro: 'gotoApp(page, baseURL, "/products")',
      expected: 'Navigation succeeds.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'environment_problem',
      customerImpact: 'Unknown - could not evaluate.',
    }));
    return { mapped: false, findings, note: `level ${level} navigation failed` };
  }

  try {
    await page.getByTestId('universal-import-file').setInputFiles(sheet.filePath);
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Could not upload the level ${level} messy file`,
      category: 'import',
      severity: 'high',
      lesson: 'import-messy',
      persona: persona?.key ?? null,
      repro: `Upload ${sheet.filePath} (format: ${sheet.format}) via universal-import-file on /products.`,
      expected: 'File input accepts the file.',
      actual: String(err && err.message ? err.message : err),
      evidence: {},
      triageClass: 'probable_app_bug',
      customerImpact: `A shop exporting from a system that produces a level ${level}-style file could not even upload it.`,
      locked: true,
    }));
    return { mapped: false, findings, note: `level ${level} upload failed` };
  }

  let previewOrMapping = null;
  try {
    previewOrMapping = await Promise.race([
      page.getByTestId('import-preview').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'preview'),
      page.getByTestId('column-mapping').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'mapping'),
    ]);
  } catch (err) {
    findings.push(triage.buildFinding({
      title: `Fuzzy mapper failed on level ${level} format - neither preview nor mapping UI appeared`,
      category: 'import',
      severity: 'medium',
      lesson: 'import-messy',
      persona: persona?.key ?? null,
      repro: `Upload ${sheet.filePath} (headers: ${JSON.stringify(sheet.headers)}, format: ${sheet.format}) via universal-import-file.`,
      expected: 'Either import-preview or column-mapping becomes visible within 15s.',
      actual: String(err && err.message ? err.message : err),
      evidence: { headerStyle: JSON.stringify(sheet.headers) },
      triageClass: 'probable_app_bug',
      customerImpact: `A shop using a system that exports level ${level}-style files could not import their inventory at all.`,
    }));
    return { mapped: false, findings, note: `level ${level}: no preview/mapping surfaced` };
  }

  if (previewOrMapping === 'mapping') {
    note = `level ${level}: low-confidence column-mapping UI surfaced (expected for messier formats).`;
    try {
      const confirmButton = page.getByTestId('mapping-confirm');
      if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmButton.click();
      }
    } catch {
      // Non-fatal: mapping-confirm may not exist or may already be dismissed.
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
      title: `import-error surfaced on a merely-messy level ${level} file`,
      category: 'import',
      severity: 'high',
      lesson: 'import-messy',
      persona: persona?.key ?? null,
      repro: `Upload ${sheet.filePath} (headers: ${JSON.stringify(sheet.headers)}) via universal-import-file.`,
      expected: 'No import-error on a merely messy (not corrupt) file - fuzzy mapping or manual mapping should handle it.',
      actual: 'import-error was visible.',
      evidence: { headerStyle: JSON.stringify(sheet.headers) },
      triageClass: 'probable_app_bug',
      customerImpact: `A shop exporting a level ${level}-style file would be blocked from importing.`,
      locked: true,
    }));
    return { mapped: false, findings, note: note ?? `level ${level}: import-error shown` };
  }

  // Level 2 only: apply end-to-end to prove the fuzzy-mapped path actually
  // completes an import, not just that a preview renders.
  if (level === 2 && previewOrMapping === 'preview') {
    try {
      await page.getByTestId('import-apply').click();
      await page.getByTestId('import-summary').waitFor({ state: 'visible', timeout: 15000 });
    } catch (err) {
      findings.push(triage.buildFinding({
        title: 'Applying the level 2 messy import failed after a successful preview',
        category: 'import',
        severity: 'high',
        lesson: 'import-messy',
        persona: persona?.key ?? null,
        repro: `Upload ${sheet.filePath}, wait for import-preview, click import-apply.`,
        expected: 'Apply completes and shows import-summary.',
        actual: String(err && err.message ? err.message : err),
        evidence: {},
        triageClass: 'probable_app_bug',
        customerImpact: 'A shop could preview a renamed-header export but not actually apply it.',
        locked: true,
      }));
      return { mapped: false, findings, note: 'level 2: apply after preview failed' };
    }
  }

  return { mapped: true, findings, note };
}
