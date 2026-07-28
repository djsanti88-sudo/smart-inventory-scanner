import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectFindings, bucketOf, summarize, buildBugReportHtml, writeBugReport } from './bugReport.mjs';

async function makeTempArtifactsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bugreport-test-'));
}

function baseFinding(overrides = {}) {
  return {
    title: 'Scan count mismatch',
    category: 'ledger',
    severity: 'critical',
    lesson: 'scan-n-count-n',
    persona: 'tire',
    repro: 'Scan 5 codes in order.',
    expected: 'feedCount === 5',
    actual: 'feedCount was 6',
    evidence: {},
    triageClass: 'confirmed_app_bug',
    customerImpact: 'Lost inventory trust.',
    options: [],
    locked: true,
    ...overrides,
  };
}

test('collectFindings dedupes by lesson::title, counts occurrences, skips unreadable json', async () => {
  const dir = await makeTempArtifactsDir();
  try {
    const runA = path.join(dir, 'r1');
    const runB = path.join(dir, 'r2');
    const badRun = path.join(dir, 'r-bad');
    await fs.mkdir(runA, { recursive: true });
    await fs.mkdir(runB, { recursive: true });
    await fs.mkdir(badRun, { recursive: true });

    await fs.writeFile(
      path.join(runA, 'report.json'),
      JSON.stringify({
        runId: 'r1',
        startedAt: '2026-07-22T20:00:00.000Z',
        finishedAt: '2026-07-22T20:01:00.000Z',
        deployment: { url: 'https://example.test' },
        findings: [
          baseFinding({ severity: 'high' }),
          { title: 'Unique to r1', lesson: 'lesson-a', severity: 'low', triageClass: 'flaky' },
        ],
      })
    );

    await fs.writeFile(
      path.join(runB, 'report.json'),
      JSON.stringify({
        runId: 'r2',
        startedAt: '2026-07-22T21:00:00.000Z',
        finishedAt: '2026-07-22T21:01:00.000Z',
        deployment: { url: 'https://example.test' },
        findings: [baseFinding({ severity: 'critical' })],
      })
    );

    // Unreadable / malformed JSON must be skipped, never throw.
    await fs.writeFile(path.join(badRun, 'report.json'), '{ not valid json ][');

    // A LOOP_REPORT.json alongside should never be picked up (no report.json here).
    const loopDir = path.join(dir, 'loop-r1');
    await fs.mkdir(loopDir, { recursive: true });
    await fs.writeFile(
      path.join(loopDir, 'LOOP_REPORT.json'),
      JSON.stringify({ cumulativeFindings: [baseFinding()] })
    );

    const { findings, meta } = await collectFindings(dir);

    assert.equal(meta.runsScanned, 2, 'only the two valid report.json dirs count as runs scanned');
    assert.equal(meta.target, 'https://example.test');
    assert.equal(meta.latestTimestamp, '2026-07-22T21:01:00.000Z');
    assert.equal(meta.totalRaw, 3, 'raw finding count before dedupe across the 2 valid runs');

    // Deduped: "scan-n-count-n::Scan count mismatch" appeared in both runs.
    const dupe = findings.find((f) => f.lesson === 'scan-n-count-n' && f.title === 'Scan count mismatch');
    assert.ok(dupe, 'deduped finding must be present');
    assert.equal(dupe.occurrences, 2, 'occurrences must count both runs');
    assert.equal(dupe.severity, 'critical', 'the highest-severity instance (critical) must be kept over high');

    const unique = findings.find((f) => f.title === 'Unique to r1');
    assert.ok(unique, 'non-duplicate finding must be kept');
    assert.equal(unique.occurrences, 1);

    assert.equal(findings.length, 2, 'exactly 2 distinct findings after dedupe');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bucketOf maps each triageClass correctly', () => {
  assert.equal(bucketOf({ triageClass: 'confirmed_app_bug' }), 'confirmed');
  assert.equal(bucketOf({ triageClass: 'probable_app_bug' }), 'probable');
  assert.equal(bucketOf({ triageClass: 'test_bug' }), 'not_app_bug');
  assert.equal(bucketOf({ triageClass: 'test_data_problem' }), 'not_app_bug');
  assert.equal(bucketOf({ triageClass: 'environment_problem' }), 'not_app_bug');
  assert.equal(bucketOf({ triageClass: 'flaky' }), 'not_app_bug');
  assert.equal(bucketOf({ triageClass: 'something_unknown' }), 'probable');
  assert.equal(bucketOf({}), 'probable');
});

test('summarize tallies severity and bucket counts', () => {
  const findings = [
    { severity: 'critical', triageClass: 'confirmed_app_bug' },
    { severity: 'high', triageClass: 'probable_app_bug' },
    { severity: 'medium', triageClass: 'test_bug' },
    { severity: 'low', triageClass: 'flaky' },
    { severity: 'critical', triageClass: 'confirmed_app_bug' },
  ];
  const summary = summarize(findings);
  assert.deepEqual(summary.bySeverity, { critical: 2, high: 1, medium: 1, low: 1 });
  assert.deepEqual(summary.byBucket, { confirmed: 2, probable: 1, not_app_bug: 2 });
  assert.equal(summary.total, 5);
});

test('buildBugReportHtml includes target, severity badge, and escapes HTML in finding text', () => {
  const findings = [
    baseFinding({
      title: '<script>alert(1)</script>',
      severity: 'high',
      triageClass: 'probable_app_bug',
      locked: false,
    }),
  ];
  const html = buildBugReportHtml(findings, {
    target: 'https://inventory-lovat-six.vercel.app',
    latestTimestamp: '2026-07-22T20:00:00.000Z',
    runsScanned: 3,
  });

  assert.match(html, /https:\/\/inventory-lovat-six\.vercel\.app/);
  assert.match(html, /sev-badge sev-high/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'raw script tag must not appear unescaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'finding title must be HTML-escaped');
});

test('writeBugReport writes a file to disk and returns a summary', async () => {
  const dir = await makeTempArtifactsDir();
  try {
    const runDir = path.join(dir, 'r1');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify({
        runId: 'r1',
        finishedAt: '2026-07-22T20:00:00.000Z',
        deployment: { url: 'https://example.test' },
        findings: [baseFinding()],
      })
    );

    const outPath = path.join(dir, 'BUG_REPORT.html');
    const result = await writeBugReport(dir, outPath);

    assert.equal(result.outPath, outPath);
    assert.equal(result.count, 1);
    assert.equal(result.summary.total, 1);

    const written = await fs.readFile(outPath, 'utf8');
    assert.match(written, /Scanbin - Teach Bot Bug Report/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeBugReport defaults outPath to <artifactsRoot>/BUG_REPORT.html', async () => {
  const dir = await makeTempArtifactsDir();
  try {
    const runDir = path.join(dir, 'r1');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify({ runId: 'r1', deployment: {}, findings: [] })
    );

    const result = await writeBugReport(dir);
    assert.equal(result.outPath, path.join(dir, 'BUG_REPORT.html'));
    const exists = await fs
      .access(result.outPath)
      .then(() => true)
      .catch(() => false);
    assert.ok(exists, 'default out path file must exist');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
