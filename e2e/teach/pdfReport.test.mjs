// e2e/teach/pdfReport.test.mjs
//
// Pure-function tests for the PDF bug report generator. Deliberately does
// NOT invoke Playwright/Chromium - writePdf (the only browser-touching
// function) is exercised manually via `node e2e/teach/pdfReport.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  collectFindingsWithSource,
  resolveScreenshot,
  routeTokenOf,
  explainFinding,
  bucketOf,
  summarize,
  buildPdfHtml,
  escapeHtml,
} from './pdfReport.mjs';

// A valid 1x1 transparent PNG (tiny, real PNG bytes - not a stub).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_BUFFER = Buffer.from(TINY_PNG_BASE64, 'base64');

async function makeTempArtifactsRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfreport-test-'));
  return root;
}

async function writeRunDir(artifactsRoot, runId, report, pngNames = []) {
  const dir = path.join(artifactsRoot, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report), 'utf8');
  for (const name of pngNames) {
    await fs.writeFile(path.join(dir, name), TINY_PNG_BUFFER);
  }
  return dir;
}

function makeReport({ findings = [], deploymentUrl = 'https://example.test' } = {}) {
  return {
    startedAt: '2026-07-22T00:00:00.000Z',
    finishedAt: '2026-07-22T00:05:00.000Z',
    deployment: { url: deploymentUrl },
    personaResults: [
      {
        persona: 'tire',
        lessons: [
          {
            id: 'smoke-controls',
            findings,
          },
        ],
      },
    ],
    findings: [],
  };
}

test('collectFindingsWithSource records sourceDir per finding and dedupes by lesson::title', async () => {
  const root = await makeTempArtifactsRoot();
  try {
    const finding = {
      title: 'Console/page error(s) observed on /products',
      category: 'console-error',
      severity: 'medium',
      lesson: 'smoke-controls',
      persona: 'tire',
      triageClass: 'probable_app_bug',
      expected: 'No console errors',
      actual: 'ERR_NAME_NOT_RESOLVED',
    };
    const runDir = await writeRunDir(root, 'r1', makeReport({ findings: [finding] }), [
      '12-smoke-controls-products.png',
    ]);

    const { findings, meta } = await collectFindingsWithSource(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sourceDir, runDir);
    assert.equal(findings[0].occurrences, 1);
    assert.equal(meta.runsScanned, 1);
    assert.equal(meta.target, 'https://example.test');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('collectFindingsWithSource skips unreadable/malformed report.json defensively', async () => {
  const root = await makeTempArtifactsRoot();
  try {
    const badDir = path.join(root, 'r-bad');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'report.json'), '{ not valid json', 'utf8');

    const noReportDir = path.join(root, 'loop-r-something');
    await fs.mkdir(noReportDir, { recursive: true });

    const { findings, meta } = await collectFindingsWithSource(root);
    assert.equal(findings.length, 0);
    assert.equal(meta.runsScanned, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolveScreenshot picks the PNG matching the route token', async () => {
  const root = await makeTempArtifactsRoot();
  try {
    const finding = {
      title: 'Console/page error(s) observed on /products',
      category: 'console-error',
      lesson: 'smoke-controls',
    };
    const runDir = await writeRunDir(root, 'r1', makeReport(), [
      '12-smoke-controls-scan.png',
      '12-smoke-controls-products.png',
      '12-smoke-controls-reconcile.png',
    ]);
    finding.sourceDir = runDir;

    const dataUri = await resolveScreenshot(finding);
    assert.ok(dataUri, 'expected a data URI');
    assert.ok(dataUri.startsWith('data:image/png;base64,'));
    // The chosen file must be the products one, not scan or reconcile.
    const productsBytes = await fs.readFile(path.join(runDir, '12-smoke-controls-products.png'));
    assert.equal(dataUri, `data:image/png;base64,${productsBytes.toString('base64')}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolveScreenshot falls back to the first PNG when no route match exists', async () => {
  const root = await makeTempArtifactsRoot();
  try {
    const finding = {
      title: 'Something broke on /reconcile',
      category: 'console-error',
      lesson: 'smoke-controls',
    };
    // Only a scan screenshot present - no reconcile screenshot in this run dir.
    const runDir = await writeRunDir(root, 'r1', makeReport(), ['12-smoke-controls-scan.png']);
    finding.sourceDir = runDir;

    const dataUri = await resolveScreenshot(finding);
    assert.ok(dataUri, 'expected a fallback data URI');
    const scanBytes = await fs.readFile(path.join(runDir, '12-smoke-controls-scan.png'));
    assert.equal(dataUri, `data:image/png;base64,${scanBytes.toString('base64')}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolveScreenshot returns null when sourceDir has no PNG at all', async () => {
  const root = await makeTempArtifactsRoot();
  try {
    const finding = { title: 'No screenshots here', lesson: 'smoke-controls' };
    const runDir = await writeRunDir(root, 'r1', makeReport(), []);
    finding.sourceDir = runDir;

    const dataUri = await resolveScreenshot(finding);
    assert.equal(dataUri, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolveScreenshot returns null when finding has no sourceDir', async () => {
  const dataUri = await resolveScreenshot({ title: 'orphan finding' });
  assert.equal(dataUri, null);
});

test('routeTokenOf derives the right token from title/category text', () => {
  assert.equal(routeTokenOf({ title: 'Console error on /products' }), 'products');
  assert.equal(routeTokenOf({ actual: 'seen on reconcile page' }), 'reconcile');
  assert.equal(routeTokenOf({ lesson: 'settings-smoke' }), 'settings');
  assert.equal(routeTokenOf({ title: 'unrelated title', category: 'ledger' }), 'scan');
});

test('explainFinding returns a non-empty humanized sentence for a console-error finding', () => {
  const sentence = explainFinding({
    category: 'console-error',
    title: 'Console/page error(s) observed on /products',
    triageClass: 'probable_app_bug',
  });
  assert.ok(typeof sentence === 'string' && sentence.length > 0);
  assert.ok(sentence.toLowerCase().includes('products'));
  assert.ok(sentence.toLowerCase().includes('javascript error'));
});

test('explainFinding mentions a test-harness quirk when triageClass is test_bug', () => {
  const sentence = explainFinding({
    category: 'ledger',
    triageClass: 'test_bug',
  });
  assert.ok(sentence.toLowerCase().includes('test'));
  assert.ok(sentence.toLowerCase().includes('quirk'));
});

test('bucketOf and summarize classify findings consistently', () => {
  const findings = [
    { severity: 'critical', triageClass: 'confirmed_app_bug' },
    { severity: 'high', triageClass: 'probable_app_bug' },
    { severity: 'medium', triageClass: 'test_bug' },
  ];
  assert.equal(bucketOf(findings[0]), 'confirmed');
  assert.equal(bucketOf(findings[1]), 'probable');
  assert.equal(bucketOf(findings[2]), 'not_app_bug');

  const summary = summarize(findings);
  assert.equal(summary.total, 3);
  assert.equal(summary.bySeverity.critical, 1);
  assert.equal(summary.byBucket.not_app_bug, 1);
});

test('buildPdfHtml returns a full HTML document containing the target and escapes injected markup', () => {
  const findings = [
    {
      title: '<script>alert(1)</script>',
      severity: 'high',
      lesson: 'smoke-controls',
      persona: 'tire',
      category: 'console-error',
      triageClass: 'probable_app_bug',
      screenshot: null,
    },
  ];
  const html = buildPdfHtml(findings, { target: 'https://example.test', runsScanned: 3 });

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('https://example.test'));
  assert.ok(html.includes(escapeHtml('<script>alert(1)</script>')));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('no screenshot' .replace(' ', '')) || html.toLowerCase().includes('no screenshot'));
});

test('buildPdfHtml handles zero findings without throwing', () => {
  const html = buildPdfHtml([], { target: 'https://example.test' });
  assert.ok(html.includes('No findings collected.'));
});
