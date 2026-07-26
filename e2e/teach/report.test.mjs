// e2e/teach/report.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { timingSection, buildReportMarkdown } from './report.mjs';

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
  test('includes a Timing section right after the Ladder diagnosis section', () => {
    const model = {
      runId: 'run-1',
      deployment: {},
      personaResults: [],
      findings: [],
      ladderRows: [],
      apiCalls: [{ urlPath: '/api/ai-lookup', method: 'POST', status: 200, latencyMs: 123 }],
      createdData: {},
      coverageDelta: {},
      limits: {},
    };
    const md = buildReportMarkdown(model);
    const ladderIdx = md.indexOf('## Ladder diagnosis');
    const timingIdx = md.indexOf('## Timing');
    assert.ok(ladderIdx >= 0, 'ladder section present');
    assert.ok(timingIdx > ladderIdx, 'timing section appears after ladder section');
  });
});
