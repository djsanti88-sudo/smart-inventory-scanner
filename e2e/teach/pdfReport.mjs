// e2e/teach/pdfReport.mjs
//
// Teach Bot PDF BUG REPORT generator: turns every finding the bot produced
// across testing/artifacts/<runId>/report.json into a single, shareable PDF
// where a non-engineer can see, per bug: a screenshot of the page it
// happened on, and a plain-English explanation of what went wrong.
//
// This module intentionally does NOT reuse bugReport.mjs's collectFindings -
// that function dedupes across runs but discards which run directory (and
// therefore which screenshots) a finding came from. Here we need the source
// run dir to locate `12-smoke-controls-<route>.png` screenshots, so we
// re-scan report.json ourselves and record `sourceDir` per finding.
//
// Pure functions (collectFindingsWithSource, resolveScreenshot, explainFinding,
// buildPdfHtml) are unit-tested without touching Playwright or a browser.
// writePdf is the only function that launches a browser; it is exercised via
// the CLI / manual run, not the automated test suite.

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// e2e/teach/pdfReport.mjs -> up two levels -> repo root
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_SECTIONS = ['critical', 'high', 'medium', 'low'];
const ROUTE_TOKENS = ['products', 'reconcile', 'settings', 'review', 'history'];

function severityRank(sev) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, sev) ? SEVERITY_ORDER[sev] : 99;
}

/**
 * Scan every `<artifactsRoot>/<runDir>/report.json`, pulling findings from
 * personaResults[].lessons[].findings[] and the top-level findings[] array
 * (both are collected; dedup collapses any overlap). Dedupes by
 * `${lesson}::${title}`, keeping the most severe instance seen and recording
 * `sourceDir` (the absolute run dir path) + `occurrences`.
 *
 * Defensive: unreadable files, non-JSON, or unexpected shapes are silently
 * skipped - this function never throws.
 * @param {string} artifactsRoot
 */
export async function collectFindingsWithSource(artifactsRoot) {
  const meta = { runsScanned: 0, latestTimestamp: null, target: null, totalRaw: 0 };
  let entries = [];
  try {
    entries = await fs.readdir(artifactsRoot, { withFileTypes: true });
  } catch {
    return { findings: [], meta };
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const kept = new Map(); // `${lesson}::${title}` -> finding with sourceDir + occurrences

  for (const dir of dirs) {
    const sourceDir = path.join(artifactsRoot, dir.name);
    const reportPath = path.join(sourceDir, 'report.json');
    let raw;
    try {
      raw = await fs.readFile(reportPath, 'utf8');
    } catch {
      continue; // no report.json in this dir (e.g. a loop-* dir) - skip
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON - skip defensively
    }

    if (!parsed || typeof parsed !== 'object') continue;

    const collected = [];
    const personaResults = Array.isArray(parsed.personaResults) ? parsed.personaResults : [];
    for (const pr of personaResults) {
      const lessons = Array.isArray(pr?.lessons) ? pr.lessons : [];
      for (const lesson of lessons) {
        const findings = Array.isArray(lesson?.findings) ? lesson.findings : [];
        collected.push(...findings);
      }
    }
    if (Array.isArray(parsed.findings)) {
      collected.push(...parsed.findings);
    }

    meta.runsScanned += 1;
    meta.totalRaw += collected.length;

    const ts = parsed.finishedAt ?? parsed.startedAt ?? parsed.deployment?.timestamp ?? null;
    if (typeof ts === 'string' && (!meta.latestTimestamp || ts > meta.latestTimestamp)) {
      meta.latestTimestamp = ts;
    }
    if (!meta.target && parsed.deployment?.url) {
      meta.target = parsed.deployment.url;
    }

    for (const f of collected) {
      if (!f || typeof f !== 'object' || !f.title) continue;
      const key = `${f.lesson ?? ''}::${f.title}`;
      const existing = kept.get(key);
      if (!existing) {
        kept.set(key, { ...f, sourceDir, occurrences: 1 });
        continue;
      }
      const occurrences = existing.occurrences + 1;
      if (severityRank(f.severity) < severityRank(existing.severity)) {
        // A more severe instance of the same finding - keep it (and its
        // sourceDir, since that's where the more severe repro happened),
        // carrying the accumulated occurrence count forward.
        kept.set(key, { ...f, sourceDir, occurrences });
      } else {
        existing.occurrences = occurrences;
      }
    }
  }

  return { findings: Array.from(kept.values()), meta };
}

/**
 * Derive a route token ('products' | 'reconcile' | 'settings' | 'review' |
 * 'history' | 'scan') from a finding's title/actual/category/lesson text.
 * @param {object} finding
 */
export function routeTokenOf(finding) {
  const haystack = [finding?.title, finding?.actual, finding?.category, finding?.lesson]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  for (const token of ROUTE_TOKENS) {
    if (haystack.includes(`/${token}`) || haystack.includes(token)) {
      return token;
    }
  }
  return 'scan';
}

/**
 * Locate the best-matching screenshot for a finding and return it as a
 * base64 data URI. Looks in finding.sourceDir for a PNG whose filename
 * contains the finding's derived route token; falls back to the first PNG
 * in sourceDir; returns null if no screenshot exists there.
 * @param {object} finding
 */
export async function resolveScreenshot(finding) {
  const sourceDir = finding?.sourceDir;
  if (!sourceDir || typeof sourceDir !== 'string') return null;

  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const pngs = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png'))
    .map((e) => e.name)
    .sort();
  if (pngs.length === 0) return null;

  const routeToken = routeTokenOf(finding);
  const routeMatch = pngs.find((name) => name.toLowerCase().includes(routeToken));
  const chosen = routeMatch ?? pngs[0];

  try {
    const bytes = await fs.readFile(path.join(sourceDir, chosen));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

const TEST_BUG_CLASSES = new Set(['test_bug', 'test_data_problem', 'environment_problem', 'flaky']);

/**
 * Produce one plain-English sentence a shop owner (not an engineer) would
 * understand, derived from the finding's category/expected/actual/triageClass.
 * @param {object} finding
 */
export function explainFinding(finding) {
  const category = finding?.category ?? '';
  const route = routeTokenOf(finding);
  const isTestQuirk = TEST_BUG_CLASSES.has(finding?.triageClass);
  const quirkSuffix = isTestQuirk
    ? ' This looks like a test-harness quirk, not necessarily a real app bug.'
    : '';

  if (category === 'console-error') {
    return `The ${route} page logged a JavaScript error while loading - something on that screen is failing under the hood.${quirkSuffix}`;
  }
  if (category === 'ledger') {
    return `The bot scanned a batch of codes but the on-screen count did not match what was scanned - this needs checking against the "every scan counts" rule (may be a test-measurement quirk).${quirkSuffix}`;
  }
  if (category === 'resolver_trust') {
    return `A scanned code that should have needed human review was instead treated as a known product - that risks a wrong item being counted.${quirkSuffix}`;
  }
  if (category === 'ui') {
    return `Something a user expects to see on the ${route} page was missing or not visible.${quirkSuffix}`;
  }

  const expected = typeof finding?.expected === 'string' ? finding.expected : null;
  const actual = typeof finding?.actual === 'string' ? finding.actual : null;
  if (expected && actual) {
    return `On the ${route} page, the app was expected to do this: "${expected}" but instead: "${actual}".${quirkSuffix}`;
  }
  return `The bot found something worth a human look on the ${route} page.${quirkSuffix}`;
}

export function bucketOf(finding) {
  const triageClass = finding?.triageClass;
  if (triageClass === 'confirmed_app_bug') return 'confirmed';
  if (triageClass === 'probable_app_bug') return 'probable';
  if (TEST_BUG_CLASSES.has(triageClass)) return 'not_app_bug';
  return 'probable';
}

export function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byBucket = { confirmed: 0, probable: 0, not_app_bug: 0 };
  for (const f of list) {
    if (Object.prototype.hasOwnProperty.call(bySeverity, f?.severity)) {
      bySeverity[f.severity] += 1;
    }
    byBucket[bucketOf(f)] += 1;
  }
  return { bySeverity, byBucket, total: list.length };
}

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BUCKET_LABEL = {
  confirmed: 'Confirmed app bug',
  probable: 'Probable app bug',
  not_app_bug: 'Likely not an app bug',
};

function findingCardHtml(f, screenshotDataUri) {
  const bucket = bucketOf(f);
  const occurrences = Number.isFinite(f.occurrences) ? f.occurrences : 1;
  const explanation = explainFinding(f);
  const screenshotHtml = screenshotDataUri
    ? `<img class="shot" src="${screenshotDataUri}" alt="Screenshot of the page where this happened" />`
    : `<div class="no-shot">No screenshot was captured for this finding.</div>`;

  return `
    <article class="card sev-${escapeHtml(f.severity ?? 'unknown')}">
      <div class="card-top">
        <span class="badge sev-badge sev-${escapeHtml(f.severity ?? 'unknown')}">${escapeHtml(f.severity ?? 'unknown')}</span>
        <span class="badge bucket-badge bucket-${escapeHtml(bucket)}">${escapeHtml(BUCKET_LABEL[bucket])}</span>
        ${f.locked ? '<span class="badge locked-badge">SACRED-LAW</span>' : ''}
      </div>
      <h3 class="card-title">${escapeHtml(f.title ?? '(untitled finding)')}</h3>
      <div class="card-meta">${escapeHtml(f.lesson ?? '(no lesson)')} - ${escapeHtml(f.persona ?? '(no persona)')} - seen ${occurrences}x</div>
      <p class="explain">${escapeHtml(explanation)}</p>
      ${screenshotHtml}
      <div class="ea-grid">
        <div><span class="label">Expected</span><p>${escapeHtml(f.expected ?? '(n/a)')}</p></div>
        <div><span class="label">Actual</span><p>${escapeHtml(f.actual ?? '(n/a)')}</p></div>
      </div>
      <div class="row"><span class="label">Repro</span><p>${escapeHtml(f.repro ?? '(n/a)')}</p></div>
      <div class="row"><span class="label">Customer impact</span><p>${escapeHtml(f.customerImpact ?? '(n/a)')}</p></div>
    </article>`;
}

function chip(label, value) {
  return `<div class="chip"><span class="chip-value">${escapeHtml(value)}</span><span class="chip-label">${escapeHtml(label)}</span></div>`;
}

/**
 * Build a full, self-contained, print-optimized HTML document for the PDF
 * bug report. `findings` must already carry a `screenshot` field (a data URI
 * or null) - see writePdf, which resolves screenshots before calling this.
 * @param {Array<object>} findings
 * @param {{ runsScanned?: number, latestTimestamp?: string|null, target?: string|null }} meta
 */
export function buildPdfHtml(findings, meta = {}) {
  const list = Array.isArray(findings) ? findings.slice() : [];
  list.sort((a, b) => severityRank(a?.severity) - severityRank(b?.severity));
  const summary = summarize(list);
  const target = meta.target ?? '(unknown target)';
  const generated = meta.latestTimestamp ?? new Date().toISOString();
  const runsScanned = Number.isFinite(meta.runsScanned) ? meta.runsScanned : 0;

  const sections = SEVERITY_SECTIONS.map((sev) => {
    const matches = list.filter((f) => f?.severity === sev);
    if (matches.length === 0) return '';
    return `
    <section class="sev-section">
      <h2>${escapeHtml(sev)} <span class="count">(${matches.length})</span></h2>
      <div class="cards">${matches.map((f) => findingCardHtml(f, f.screenshot)).join('')}</div>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Scanbin - Teach Bot Bug Report</title>
<style>
  @page { margin: 14mm; }
  :root {
    --bg: #f6f7f9; --card-bg: #ffffff; --text: #1a1d21; --muted: #5b6270; --border: #dde1e6;
    --critical: #b3261e; --high: #b5601a; --medium: #8a7b00; --low: #3a6b3a;
    --confirmed: #b3261e; --probable: #8a5a00; --not_app_bug: #3a6b8f; --locked: #6b3fa0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.45; font-size: 13px;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 8px 4px 40px; }
  .cover { page-break-after: always; padding-top: 40px; }
  .cover h1 { font-size: 1.9rem; margin: 0 0 8px; }
  .cover .sub { color: var(--muted); font-size: 1rem; margin: 4px 0; }
  .banner {
    margin: 20px 0; padding: 14px 18px; border: 1px solid var(--border);
    border-left: 4px solid var(--not_app_bug); border-radius: 6px; background: var(--card-bg);
    font-size: 0.92rem; color: var(--muted);
  }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0; }
  .chip { border: 1px solid var(--border); background: var(--card-bg); border-radius: 8px; padding: 10px 16px; min-width: 100px; text-align: center; }
  .chip-value { display: block; font-size: 1.4rem; font-weight: 700; }
  .chip-label { display: block; font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  table.summary { border-collapse: collapse; width: 100%; margin-top: 18px; }
  table.summary th, table.summary td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; font-size: 0.85rem; }
  table.summary th { background: var(--card-bg); }
  .sev-section { margin-top: 20px; page-break-before: always; }
  .sev-section h2 { text-transform: capitalize; font-size: 1.2rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .sev-section h2 .count { color: var(--muted); font-weight: 400; font-size: 0.9rem; }
  .cards { display: grid; gap: 16px; margin-top: 10px; }
  .card {
    border: 1px solid var(--border); background: var(--card-bg); border-radius: 8px;
    padding: 16px 18px; page-break-inside: avoid;
  }
  .card-top { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .badge {
    display: inline-block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.03em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border);
  }
  .sev-badge.sev-critical { color: var(--critical); border-color: var(--critical); }
  .sev-badge.sev-high { color: var(--high); border-color: var(--high); }
  .sev-badge.sev-medium { color: var(--medium); border-color: var(--medium); }
  .sev-badge.sev-low { color: var(--low); border-color: var(--low); }
  .bucket-badge.bucket-confirmed { color: var(--confirmed); border-color: var(--confirmed); }
  .bucket-badge.bucket-probable { color: var(--probable); border-color: var(--probable); }
  .bucket-badge.bucket-not_app_bug { color: var(--not_app_bug); border-color: var(--not_app_bug); }
  .locked-badge { color: var(--locked); border-color: var(--locked); }
  .card-title { margin: 0 0 4px; font-size: 1.05rem; }
  .card-meta { color: var(--muted); font-size: 0.8rem; margin-bottom: 8px; }
  .explain {
    background: #eef2f7; border-radius: 6px; padding: 10px 12px; font-size: 0.95rem;
    font-weight: 600; margin: 8px 0 12px;
  }
  .shot { max-width: 100%; border: 1px solid var(--border); border-radius: 4px; margin-bottom: 12px; display: block; }
  .no-shot {
    color: var(--muted); font-style: italic; font-size: 0.85rem; border: 1px dashed var(--border);
    border-radius: 6px; padding: 14px; text-align: center; margin-bottom: 12px;
  }
  .ea-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
  .label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); margin-bottom: 2px; }
  .row { margin-bottom: 8px; }
  .row p, .ea-grid p { margin: 0; font-size: 0.88rem; word-break: break-word; }
  footer { margin-top: 32px; color: var(--muted); font-size: 0.78rem; border-top: 1px solid var(--border); padding-top: 12px; }
  .empty { color: var(--muted); font-style: italic; margin-top: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="cover">
    <h1>Scanbin - Teach Bot Bug Report</h1>
    <p class="sub">Target: ${escapeHtml(target)}</p>
    <p class="sub">Generated: ${escapeHtml(generated)}</p>
    <p class="sub">Runs scanned: ${escapeHtml(runsScanned)}</p>

    <div class="banner">
      Findings are auto-triaged by the Teach Bot. "Confirmed" bugs reproduced via an automated
      assertion, but that may still be a harness measurement artifact - verify before acting.
      Nothing in this report was auto-fixed. Every screenshot shows the actual page the bot saw
      at the moment of the finding.
    </div>

    <div class="chips">
      ${chip('Total', summary.total)}
      ${chip('Critical', summary.bySeverity.critical)}
      ${chip('High', summary.bySeverity.high)}
      ${chip('Medium', summary.bySeverity.medium)}
      ${chip('Low', summary.bySeverity.low)}
    </div>

    <table class="summary">
      <thead><tr><th>Category</th><th>Count</th></tr></thead>
      <tbody>
        <tr><td>Confirmed app bug</td><td>${escapeHtml(summary.byBucket.confirmed)}</td></tr>
        <tr><td>Probable app bug</td><td>${escapeHtml(summary.byBucket.probable)}</td></tr>
        <tr><td>Likely not an app bug</td><td>${escapeHtml(summary.byBucket.not_app_bug)}</td></tr>
      </tbody>
    </table>
  </div>

  ${list.length === 0 ? '<p class="empty">No findings collected.</p>' : sections}

  <footer>Generated by Teach Bot. Diagnose-only - nothing here was auto-fixed.</footer>
</div>
</body>
</html>
`;
}

/**
 * Collect findings (with source dirs), resolve each finding's screenshot,
 * build the print-optimized HTML, render it to a PDF via Playwright/Chromium,
 * and return a summary.
 * @param {string} artifactsRoot
 * @param {string} [outPath] defaults to `${artifactsRoot}/BUG_REPORT.pdf`
 */
export async function writePdf(artifactsRoot, outPath) {
  const resolvedOutPath = outPath ?? path.join(artifactsRoot, 'BUG_REPORT.pdf');
  const { findings, meta } = await collectFindingsWithSource(artifactsRoot);

  const withScreenshots = await Promise.all(
    findings.map(async (f) => ({ ...f, screenshot: await resolveScreenshot(f) }))
  );

  const html = buildPdfHtml(withScreenshots, meta);

  const { chromium } = await import('playwright');
  await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: resolvedOutPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }

  const summary = summarize(withScreenshots);
  return { outPath: resolvedOutPath, count: withScreenshots.length, summary };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { artifacts: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--artifacts' && argv[i + 1]) {
      args.artifacts = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--out' && argv[i + 1]) {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const artifactsRoot = args.artifacts
    ? path.resolve(args.artifacts)
    : path.join(DEFAULT_REPO_ROOT, 'testing', 'artifacts');
  const outPath = args.out ? path.resolve(args.out) : undefined;

  const result = await writePdf(artifactsRoot, outPath);
  const { summary } = result;
  console.log(`PDF bug report written: ${result.outPath}`);
  console.log(
    `Findings: ${result.count} total - severity: critical ${summary.bySeverity.critical}, high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low} - bucket: confirmed ${summary.byBucket.confirmed}, probable ${summary.byBucket.probable}, not_app_bug ${summary.byBucket.not_app_bug}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((err) => {
    console.error('pdfReport CLI failed:', err);
    process.exitCode = 1;
  });
}
