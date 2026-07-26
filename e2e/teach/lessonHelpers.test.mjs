// e2e/teach/lessonHelpers.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildWedgeKeys, median, feedRowsFromCount, attachLadderCapture } from './lessonHelpers.mjs';

// ---------------------------------------------------------------------------
// Fake Playwright page/response/request objects for attachLadderCapture unit
// tests - just enough of the API surface the handler actually calls:
// page.on/off('response', handler), response.request(), response.url(),
// response.json(), request.method(), request.postData(), request.timing().
// ---------------------------------------------------------------------------

function makeFakePage() {
  let handler = null;
  return {
    on(event, fn) {
      if (event === 'response') handler = fn;
    },
    off(event, fn) {
      if (event === 'response' && handler === fn) handler = null;
    },
    async fire(response) {
      if (handler) await handler(response);
    },
  };
}

function makeFakeResponse({ url, method = 'POST', postData = null, jsonBody = {}, timing = null, status = 200 }) {
  return {
    url: () => url,
    status: () => status,
    json: async () => jsonBody,
    request: () => ({
      method: () => method,
      postData: () => postData,
      timing: () => timing,
    }),
  };
}

function makeFakeLimits() {
  const calls = { recordPaidLookup: [], recordRequest: 0 };
  return {
    calls,
    recordPaidLookup(rung) {
      calls.recordPaidLookup.push(rung);
    },
    recordRequest() {
      calls.recordRequest += 1;
    },
  };
}

describe('buildWedgeKeys', () => {
  test('splits a code into per-character keys + Enter terminator', () => {
    assert.deepEqual(buildWedgeKeys('AB1'), ['A', 'B', '1', 'Enter']);
  });

  test('respects a Tab suffix', () => {
    assert.deepEqual(buildWedgeKeys('X9', 'Tab'), ['X', '9', 'Tab']);
  });

  test('empty code still emits the terminator key', () => {
    assert.deepEqual(buildWedgeKeys('', 'Enter'), ['Enter']);
  });
});

describe('median', () => {
  test('odd-length array', () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  test('even-length array averages the two middle values', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  test('empty array is NaN', () => {
    assert.ok(Number.isNaN(median([])));
  });

  test('does not mutate the input array', () => {
    const input = [3, 1, 2];
    median(input);
    assert.deepEqual(input, [3, 1, 2]);
  });
});

describe('feedRowsFromCount', () => {
  test('subtracts the empty-state row when present', () => {
    assert.equal(feedRowsFromCount(5, true), 4);
  });

  test('leaves the count untouched when no empty-state row is present', () => {
    assert.equal(feedRowsFromCount(5, false), 5);
  });
});

describe('attachLadderCapture timing + call coverage', () => {
  test('records latencyMs from responseEnd on an ai-lookup trace', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/ai-lookup',
        postData: JSON.stringify({ code: '012345678905' }),
        jsonBody: { debug: { ladderPath: 'gpt' } },
        timing: { responseStart: 400, responseEnd: 842 },
      })
    );

    assert.equal(capture.traces.length, 1);
    assert.equal(capture.traces[0].latencyMs, 842);
    capture.stop();
  });

  test('falls back to responseStart when responseEnd is -1/unavailable', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/ai-lookup',
        postData: JSON.stringify({ code: '012345678905' }),
        jsonBody: {},
        timing: { responseStart: 250, responseEnd: -1 },
      })
    );

    assert.equal(capture.traces[0].latencyMs, 250);
    capture.stop();
  });

  test('latencyMs is null when timing() returns null/unavailable', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/ai-lookup',
        postData: JSON.stringify({ code: '012345678905' }),
        jsonBody: {},
        timing: null,
      })
    );

    assert.equal(capture.traces[0].latencyMs, null);
    capture.stop();
  });

  test('rows() includes latencyMs via ladderTableRow', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/ai-lookup',
        postData: JSON.stringify({ code: '012345678905' }),
        jsonBody: { debug: { ladderPath: 'gpt' } },
        timing: { responseStart: 10, responseEnd: 500 },
      })
    );

    assert.equal(capture.rows()[0].latencyMs, 500);
    capture.stop();
  });

  test('apiCalls() records every /api/* response, not just ai-lookup', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/ai-lookup',
        method: 'POST',
        postData: JSON.stringify({ code: '1' }),
        jsonBody: {},
        timing: { responseStart: 0, responseEnd: 100 },
        status: 200,
      })
    );
    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/scan',
        method: 'POST',
        jsonBody: {},
        timing: { responseStart: 0, responseEnd: 50 },
        status: 201,
      })
    );
    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/products?businessId=abc',
        method: 'GET',
        jsonBody: {},
        timing: { responseStart: 0, responseEnd: 30 },
        status: 200,
      })
    );

    const calls = capture.apiCalls();
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.urlPath).sort(),
      ['/api/ai-lookup', '/api/products', '/api/scan'].sort()
    );
    assert.equal(calls.find((c) => c.urlPath === '/api/scan').status, 201);
    assert.equal(calls.find((c) => c.urlPath === '/api/scan').method, 'POST');
    assert.equal(calls.find((c) => c.urlPath === '/api/scan').latencyMs, 50);
    capture.stop();
  });

  test('apiCalls() ignores non-api responses', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/_next/static/chunk.js',
        method: 'GET',
        jsonBody: {},
        timing: { responseStart: 0, responseEnd: 10 },
      })
    );

    assert.equal(capture.apiCalls().length, 0);
    capture.stop();
  });

  test('existing ai-lookup parsing and limits charging is unaffected by the new capture', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);

    await page.fire(
      makeFakeResponse({
        url: 'https://app.example/api/ai-lookup',
        postData: JSON.stringify({ code: '012345678905' }),
        jsonBody: { debug: { ladderPath: 'goupc' } },
        timing: { responseStart: 0, responseEnd: 111 },
      })
    );

    assert.equal(capture.traces[0].code, '012345678905');
    assert.equal(capture.traces[0].parsed.settledRung, 'goupc');
    assert.deepEqual(limits.calls.recordPaidLookup, ['goupc']);
    assert.equal(limits.calls.recordRequest, 1);
    capture.stop();
  });

  test('a broken response (json() throws) still gets recorded in apiCalls defensively', async () => {
    const page = makeFakePage();
    const limits = makeFakeLimits();
    const capture = attachLadderCapture(page, limits);
    const badResponse = {
      url: () => 'https://app.example/api/ai-lookup',
      status: () => 500,
      json: async () => {
        throw new Error('bad json');
      },
      request: () => ({
        method: () => 'POST',
        postData: () => null,
        timing: () => ({ responseStart: 0, responseEnd: 20 }),
      }),
    };

    await page.fire(badResponse);

    // Should not throw, and the ai-lookup trace still gets recorded (parsed as
    // a well-formed default) even though the json body was unparseable.
    assert.equal(capture.traces.length, 1);
    capture.stop();
  });
});
