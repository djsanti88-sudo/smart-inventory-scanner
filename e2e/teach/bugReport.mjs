// e2e/teach/bugReport.mjs
//
// Teach Bot BUG REPORT generator: aggregates every finding the bot produced
// across every run's testing/artifacts/<runId>/report.json into ONE
// self-contained, one-page HTML report, honestly triaged so real app bugs
// are separated from the harness's own false-positives.
//
// Data source: testing/artifacts/<runId>/report.json (written by report.mjs).
// LOOP_REPORT.json files are intentionally skipped - they are a cumulative
// view of the same underlying per-run findings and would double-count them.
//
// Pure functions (collectFindings/bucketOf/summarize/buildBugReportHtml) are
// unit-tested without touching the real filesystem; writeBugReport is the
// only I/O entry point.

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// e2e/teach/bugReport.mjs -> up two levels -> repo root
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function severityRank(sev) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, sev) ? SEVERITY_ORDER[sev] : 99;
}

/**
 * Scan every `<artifactsRoot>/*\/report.json` (LOOP_REPORT.json is skipped on
 * purpose - it is a cumulative re-statement of the same findings). Defensive:
 * unreadable files, non-JSON, or unexpected shapes are silently skipped, this
 * function never throws.
 * @param {string} artifactsRoot
 */
export async function collectFindings(artifactsRoot) {
  const meta = { runsScanned: 0, latestTimestamp: null, target: null, totalRaw: 0 };
  let entries = [];
  try {
    entries = await fs.readdir(artifactsRoot, { withFileTypes: true });
  } catch {
    return { findings: [], meta };
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const kept = new Map(); // `${lesson}::${title}` -> finding with occurrences

  for (const dir of dirs) {
    const reportPath = path.join(artifactsRoot, dir.name, 'report.json');
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

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    meta.runsScanned += 1;
    meta.totalRaw += findings.length;

    const ts = parsed.finishedAt ?? parsed.startedAt ?? parsed.deployment?.timestamp ?? null;
    if (typeof ts === 'string' && (!meta.latestTimestamp || ts > meta.latestTimestamp)) {
      meta.latestTimestamp = ts;
    }
    if (!meta.target && parsed.deployment?.url) {
      meta.target = parsed.deployment.url;
    }

    for (const f of findings) {
      if (!f || typeof f !== 'object' || !f.title) continue;
      const key = `${f.lesson ?? ''}::${f.title}`;
      const existing = kept.get(key);
      if (!existing) {
        kept.set(key, { ...f, occurrences: 1 });
        continue;
      }
      const occurrences = existing.occurrences + 1;
      if (severityRank(f.severity) < severityRank(existing.severity)) {
        // A more severe instance of the same finding - keep it, carry the
        // accumulated occurrence count forward.
        kept.set(key, { ...f, occurrences });
      } else {
        existing.occurrences = occurrences;
      }
    }
  }

  return { findings: Array.from(kept.values()), meta };
}

/**
 * Map a finding's triageClass to a display bucket.
 * @param {{ triageClass?: string }} finding
 */
export function bucketOf(finding) {
  const triageClass = finding?.triageClass;
  if (triageClass === 'confirmed_app_bug') return 'confirmed';
  if (triageClass === 'probable_app_bug') return 'probable';
  if (
    triageClass === 'test_bug' ||
    triageClass === 'test_data_problem' ||
    triageClass === 'environment_problem' ||
    triageClass === 'flaky'
  ) {
    return 'not_app_bug';
  }
  return 'probable';
}

/**
 * Tally findings by severity and by bucket.
 * @param {Array<object>} findings
 */
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

const BUCKET_CLASS = {
  confirmed: 'bucket-confirmed',
  probable: 'bucket-probable',
  not_app_bug: 'bucket-not-app-bug',
};

function findingCardHtml(f) {
  const bucket = bucketOf(f);
  const options = Array.isArray(f.options) ? f.options : [];
  const optionsHtml =
    options.length > 0
      ? `<ul class="options">${options
          .map((opt) => `<li>${escapeHtml(typeof opt === 'string' ? opt : JSON.stringify(opt))}</li>`)
          .join('')}</ul>`
      : '';
  const occurrences = Number.isFinite(f.occurrences) ? f.occurrences : 1;

  return `
    <article class="card sev-${escapeHtml(f.severity ?? 'unknown')}">
      <div class="card-top">
        <span class="badge sev-badge sev-${escapeHtml(f.severity ?? 'unknown')}">${escapeHtml(f.severity ?? 'unknown')}</span>
        <span class="badge bucket-badge ${BUCKET_CLASS[bucket]}">${escapeHtml(BUCKET_LABEL[bucket])}</span>
        ${f.locked ? '<span class="badge locked-badge">SACRED-LAW (report only)</span>' : ''}
      </div>
      <h3 class="card-title">${escapeHtml(f.title ?? '(untitled finding)')}</h3>
      <div class="card-meta">${escapeHtml(f.lesson ?? '(no lesson)')} - ${escapeHtml(f.persona ?? '(no persona)')} - seen ${occurrences}x</div>
      <div class="ea-grid">
        <div><span class="label">Expected</span><p>${escapeHtml(f.expected ?? '(n/a)')}</p></div>
        <div><span class="label">Actual</span><p>${escapeHtml(f.actual ?? '(n/a)')}</p></div>
      </div>
      <div class="row"><span class="label">Repro</span><p>${escapeHtml(f.repro ?? '(n/a)')}</p></div>
      <div class="row"><span class="label">Customer impact</span><p>${escapeHtml(f.customerImpact ?? '(n/a)')}</p></div>
      ${options.length > 0 ? `<div class="row"><span class="label">Options</span>${optionsHtml}</div>` : ''}
    </article>`;
}

const SEVERITY_SECTIONS = ['critical', 'high', 'medium', 'low'];

function severitySectionHtml(severity, findings) {
  const matches = findings.filter((f) => f?.severity === severity);
  if (matches.length === 0) return '';
  return `
    <section class="sev-section">
      <h2>${escapeHtml(severity)} <span class="count">(${matches.length})</span></h2>
      <div class="cards">${matches.map(findingCardHtml).join('')}</div>
    </section>`;
}

function chip(label, value, extraClass = '') {
  return `<div class="chip ${extraClass}"><span class="chip-value">${escapeHtml(value)}</span><span class="chip-label">${escapeHtml(label)}</span></div>`;
}

/**
 * Build a single self-contained HTML string for the bug report. No external
 * resources; theme-aware via prefers-color-scheme; responsive.
 * @param {Array<object>} findings deduped findings (see collectFindings)
 * @param {{ runsScanned?: number, latestTimestamp?: string|null, target?: string|null, totalRaw?: number }} meta
 */
export function buildBugReportHtml(findings, meta = {}) {
  const list = Array.isArray(findings) ? findings.slice() : [];
  list.sort((a, b) => severityRank(a?.severity) - severityRank(b?.severity));
  const summary = summarize(list);
  const target = meta.target ?? '(unknown target)';
  const generated = meta.latestTimestamp ?? '(unknown time)';
  const runsScanned = Number.isFinite(meta.runsScanned) ? meta.runsScanned : 0;

  const sections = SEVERITY_SECTIONS.map((sev) => severitySectionHtml(sev, list)).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Scanbin - Teach Bot Bug Report</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card-bg: #ffffff;
    --text: #1a1d21;
    --muted: #5b6270;
    --border: #dde1e6;
    --critical: #b3261e;
    --high: #b5601a;
    --medium: #8a7b00;
    --low: #3a6b3a;
    --confirmed: #b3261e;
    --probable: #8a5a00;
    --not-app-bug: #3a6b8f;
    --locked: #6b3fa0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --card-bg: #1e2126;
      --text: #e8eaed;
      --muted: #a2a9b5;
      --border: #33373f;
      --critical: #ff8a80;
      --high: #ffb570;
      --medium: #f0d264;
      --low: #8fd18f;
      --confirmed: #ff8a80;
      --probable: #f0c15a;
      --not-app-bug: #8ec2f2;
      --locked: #c9a4ef;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14161a; --card-bg: #1e2126; --text: #e8eaed; --muted: #a2a9b5; --border: #33373f;
    --critical: #ff8a80; --high: #ffb570; --medium: #f0d264; --low: #8fd18f;
    --confirmed: #ff8a80; --probable: #f0c15a; --not-app-bug: #8ec2f2; --locked: #c9a4ef;
  }
  :root[data-theme="light"] {
    --bg: #f6f7f9; --card-bg: #ffffff; --text: #1a1d21; --muted: #5b6270; --border: #dde1e6;
    --critical: #b3261e; --high: #b5601a; --medium: #8a7b00; --low: #3a6b3a;
    --confirmed: #b3261e; --probable: #8a5a00; --not-app-bug: #3a6b8f; --locked: #6b3fa0;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.4;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 24px 20px 64px; }
  header h1 { font-size: 1.5rem; margin: 0 0 4px; }
  header .sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 4px; }
  .banner {
    margin: 16px 0 20px;
    padding: 12px 16px;
    border: 1px solid var(--border);
    border-left: 4px solid var(--not-app-bug);
    border-radius: 6px;
    background: var(--card-bg);
    font-size: 0.88rem;
    color: var(--muted);
  }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 8px; }
  .chip {
    border: 1px solid var(--border);
    background: var(--card-bg);
    border-radius: 8px;
    padding: 8px 14px;
    min-width: 96px;
    text-align: center;
  }
  .chip-value { display: block; font-size: 1.3rem; font-weight: 700; }
  .chip-label { display: block; font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .sev-section { margin-top: 26px; }
  .sev-section h2 { text-transform: capitalize; font-size: 1.1rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .sev-section h2 .count { color: var(--muted); font-weight: 400; font-size: 0.9rem; }
  .cards { display: grid; gap: 12px; margin-top: 10px; }
  .card {
    border: 1px solid var(--border);
    background: var(--card-bg);
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
  }
  .card-top { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .sev-badge.sev-critical { color: var(--critical); border-color: var(--critical); }
  .sev-badge.sev-high { color: var(--high); border-color: var(--high); }
  .sev-badge.sev-medium { color: var(--medium); border-color: var(--medium); }
  .sev-badge.sev-low { color: var(--low); border-color: var(--low); }
  .bucket-badge.bucket-confirmed { color: var(--confirmed); border-color: var(--confirmed); }
  .bucket-badge.bucket-probable { color: var(--probable); border-color: var(--probable); }
  .bucket-badge.bucket-not-app-bug { color: var(--not-app-bug); border-color: var(--not-app-bug); }
  .locked-badge { color: var(--locked); border-color: var(--locked); }
  .card-title { margin: 0 0 4px; font-size: 1rem; }
  .card-meta { color: var(--muted); font-size: 0.8rem; margin-bottom: 8px; }
  .ea-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
  @media (max-width: 560px) { .ea-grid { grid-template-columns: 1fr; } }
  .label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); margin-bottom: 2px; }
  .row { margin-bottom: 8px; }
  .row p, .ea-grid p { margin: 0; font-size: 0.88rem; word-break: break-word; }
  .options { margin: 4px 0 0; padding-left: 18px; font-size: 0.85rem; }
  footer { margin-top: 32px; color: var(--muted); font-size: 0.78rem; border-top: 1px solid var(--border); padding-top: 12px; }
  .empty { color: var(--muted); font-style: italic; margin-top: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Scanbin - Teach Bot Bug Report</h1>
    <p class="sub">Target: ${escapeHtml(target)}</p>
    <p class="sub">Generated: ${escapeHtml(generated)} - runs scanned: ${escapeHtml(runsScanned)}</p>
  </header>

  <div class="banner">
    Findings are auto-triaged by the Teach Bot. "Confirmed" means the lesson reproduced the
    defect via an automated assertion, which may still be a harness measurement artifact -
    verify before acting. Nothing on this page was auto-fixed; this is diagnose-only output.
  </div>

  <div class="chips">
    ${chip('Total', summary.total)}
    ${chip('Critical', summary.bySeverity.critical)}
    ${chip('High', summary.bySeverity.high)}
    ${chip('Medium', summary.bySeverity.medium)}
    ${chip('Low', summary.bySeverity.low)}
    ${chip('Confirmed', summary.byBucket.confirmed)}
    ${chip('Probable', summary.byBucket.probable)}
    ${chip('Not app bug', summary.byBucket.not_app_bug)}
  </div>

  ${list.length === 0 ? '<p class="empty">No findings collected.</p>' : sections}

  <footer>Generated by Teach Bot. Diagnose-only - nothing here was auto-fixed.</footer>
</div>
</body>
</html>
`;
}

/**
 * Collect findings and write the self-contained HTML bug report to disk.
 * @param {string} artifactsRoot
 * @param {string} [outPath] defaults to `${artifactsRoot}/BUG_REPORT.html`
 */
export async function writeBugReport(artifactsRoot, outPath) {
  const resolvedOutPath = outPath ?? path.join(artifactsRoot, 'BUG_REPORT.html');
  const { findings, meta } = await collectFindings(artifactsRoot);
  const html = buildBugReportHtml(findings, meta);
  await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });
  await fs.writeFile(resolvedOutPath, html, 'utf8');
  const summary = summarize(findings);
  return { outPath: resolvedOutPath, summary, count: findings.length };
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

  const result = await writeBugReport(artifactsRoot, outPath);
  const { summary } = result;
  console.log(`Bug report written: ${result.outPath}`);
  console.log(
    `Findings: ${result.count} total - severity: critical ${summary.bySeverity.critical}, high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, low ${summary.bySeverity.low} - bucket: confirmed ${summary.byBucket.confirmed}, probable ${summary.byBucket.probable}, not_app_bug ${summary.byBucket.not_app_bug}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((err) => {
    console.error('bugReport CLI failed:', err);
    process.exitCode = 1;
  });
}
