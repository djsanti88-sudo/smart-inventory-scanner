// e2e/teach/report.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { timingSection, oracleSection, buildReportMarkdown } from './report.mjs';

describe('timingSection', () => {
  test('renders a markdown table with the expected columns', () => {
    const md = timingSection([
      { urlPath: '/api/ai-lookup', method: 'POST', status: 200, latencyMs: 500 },
    ]);
    assert.match(md, /## Timing/);
    assert.match(md, /\| urlPath \| method \| status \| latencyMs \|/);
    assert.match(md, /\| \/api\/ai-lookup \| POST \| 200 \| 500 \|/);
  });

  test('sorts rows slowest-first', () => {
    const md = timingSection([
      { urlPath: '/api/fast', method: 'GET', status: 200, latencyMs: 50 },
      { urlPath: '/api/slow', method: 'POST', status: 200, latencyMs: 900 },
      { urlPath: '/api/mid', method: 'GET', status: 200, latencyMs: 300 },
    ]);
    const slowIdx = md.indexOf('/api/slow');
    const midIdx = md.indexOf('/api/mid');
    const fastIdx = md.indexOf('/api/fast');
    assert.ok(slowIdx < midIdx);
    assert.ok(midIdx < fastIdx);
  });

  test('empty array renders a "no calls captured" placeholder, no throw', () => {
    const md = timingSection([]);
    assert.match(md, /## Timing/);
    assert.match(md, /no api calls captured/i);
  });

  test('non-array input is treated as empty (defensive)', () => {
    const md = timingSection(undefined);
    assert.match(md, /no api calls captured/i);
  });

  test('null/undefined latencyMs renders as a dash, not throw or NaN', () => {
    const md = timingSection([{ urlPath: '/api/x', method: 'GET', status: 200, latencyMs: null }]);
    assert.match(md, /\| \/api\/x \| GET \| 200 \| - \|/);
  });

  test('rows with null latencyMs sort after rows with numeric latencyMs', () => {
    const md = timingSection([
      { urlPath: '/api/unknown', method: 'GET', status: 200, latencyMs: null },
      { urlPath: '/api/known', method: 'GET', status: 200, latencyMs: 100 },
    ]);
    assert.ok(md.indexOf('/api/known') < md.indexOf('/api/unknown'));
  });
});

describe('buildReportMarkdown timing section placement', () => {
  test('includes a Timing section right after the DecodeTrace diagnosis section', () => {
    const model = {
      runId: 'run-1',
      deployment: {},
      personaResults: [],
      findings: [],
      decodeTraceRows: [],
      apiCalls: [{ urlPath: '/api/ai-lookup', method: 'POST', status: 200, latencyMs: 123 }],
      createdData: {},
      coverageDelta: {},
      limits: {},
    };
    const md = buildReportMarkdown(model);
    const decodeTraceIdx = md.indexOf('## DecodeTrace diagnosis');
    const timingIdx = md.indexOf('## Timing');
    assert.ok(decodeTraceIdx >= 0, 'decodeTrace section present');
    assert.ok(timingIdx > decodeTraceIdx, 'timing section appears after decodeTrace section');
  });
});

describe('oracleSection', () => {
  test('renders a markdown table with the expected columns', () => {
    const md = oracleSection([
      { code: '070330645936', expected: 'BIC Pocket Lighter', observed: 'BIC Pocket Lighter', match: true },
    ]);
    assert.match(md, /## Correctness oracle/);
    assert.match(md, /\| code \| expected \| observed \| match \|/);
    assert.match(md, /\| 070330645936 \| BIC Pocket Lighter \| BIC Pocket Lighter \| yes \|/);
  });

  test('formats {name,brand} identity objects as "brand - name"', () => {
    const md = oracleSection([
      {
        code: '848983006257',
        expected: { name: 'Wildpeak A T3w', brand: 'Falken' },
        observed: { name: 'Wildpeak A T3w', brand: 'Falken' },
        match: true,
      },
    ]);
    assert.match(md, /Falken - Wildpeak A T3w/);
  });

  test('a miss renders match "no"', () => {
    const md = oracleSection([
      { code: '710154236681', expected: 'Some Product', observed: '', match: false },
    ]);
    assert.match(md, /\| 710154236681 \| Some Product \| - \| no \|/);
  });

  test('renders a pass/total summary line', () => {
    const md = oracleSection([
      { code: 'a', expected: 'x', observed: 'x', match: true },
      { code: 'b', expected: 'y', observed: '', match: false },
    ]);
    assert.match(md, /1\/2 corpus codes resolved/);
  });

  test('empty array renders a "no oracle checks" placeholder, no throw', () => {
    const md = oracleSection([]);
    assert.match(md, /## Correctness oracle/);
    assert.match(md, /no oracle checks run/i);
  });

  test('non-array input is treated as empty (defensive)', () => {
    const md = oracleSection(undefined);
    assert.match(md, /no oracle checks run/i);
  });
});

describe('buildReportMarkdown oracle section placement', () => {
  test('includes a Correctness oracle section right after the Timing section', () => {
    const model = {
      runId: 'run-1',
      deployment: {},
      personaResults: [],
      findings: [],
      decodeTraceRows: [],
      apiCalls: [{ urlPath: '/api/ai-lookup', method: 'POST', status: 200, latencyMs: 123 }],
      oracleResults: [{ code: 'x', expected: 'X', observed: 'X', match: true }],
      createdData: {},
      coverageDelta: {},
      limits: {},
    };
    const md = buildReportMarkdown(model);
    const timingIdx = md.indexOf('## Timing');
    const oracleIdx = md.indexOf('## Correctness oracle');
    const createdIdx = md.indexOf('## Created data');
    assert.ok(oracleIdx > timingIdx, 'oracle section appears after timing section');
    assert.ok(createdIdx > oracleIdx, 'oracle section appears before created-data section');
  });

  test('omitting oracleResults does not throw (renders placeholder)', () => {
    const model = {
      runId: 'run-1',
      deployment: {},
      findings: [],
      decodeTraceRows: [],
      apiCalls: [],
      createdData: {},
      coverageDelta: {},
      limits: {},
    };
    const md = buildReportMarkdown(model);
    assert.match(md, /## Correctness oracle/);
    assert.match(md, /no oracle checks run/i);
  });
});
