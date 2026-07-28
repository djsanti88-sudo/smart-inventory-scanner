// e2e/teach/callCoverage.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { missingExpectedCalls } from './callCoverage.mjs';

describe('missingExpectedCalls', () => {
  test('returns empty array when every expected path was observed', () => {
    const observed = ['/api/ai-lookup', '/api/scan'];
    const expected = ['/api/ai-lookup', '/api/scan'];
    assert.deepEqual(missingExpectedCalls(observed, expected), []);
  });

  test('returns the expected paths that never appeared', () => {
    const observed = ['/api/ai-lookup'];
    const expected = ['/api/ai-lookup', '/api/scan', '/api/sync'];
    assert.deepEqual(missingExpectedCalls(observed, expected), ['/api/scan', '/api/sync']);
  });

  test('extra observed paths not in expected are ignored (not reported missing)', () => {
    const observed = ['/api/ai-lookup', '/api/telemetry', '/api/whatever'];
    const expected = ['/api/ai-lookup'];
    assert.deepEqual(missingExpectedCalls(observed, expected), []);
  });

  test('path matching is case-insensitive', () => {
    const observed = ['/API/AI-LOOKUP'];
    const expected = ['/api/ai-lookup'];
    assert.deepEqual(missingExpectedCalls(observed, expected), []);
  });

  test('query strings are stripped before comparing', () => {
    const observed = ['/api/ai-lookup?code=012345678905&mode=decode'];
    const expected = ['/api/ai-lookup'];
    assert.deepEqual(missingExpectedCalls(observed, expected), []);
  });

  test('expected paths with query strings are also stripped', () => {
    const observed = ['/api/ai-lookup'];
    const expected = ['/api/ai-lookup?foo=bar'];
    assert.deepEqual(missingExpectedCalls(observed, expected), []);
  });

  test('empty expected array yields no missing calls', () => {
    assert.deepEqual(missingExpectedCalls(['/api/ai-lookup'], []), []);
  });

  test('empty observed array reports every expected path as missing', () => {
    assert.deepEqual(missingExpectedCalls([], ['/api/ai-lookup', '/api/scan']), ['/api/ai-lookup', '/api/scan']);
  });

  test('non-array observed/expected are treated as empty (defensive)', () => {
    assert.deepEqual(missingExpectedCalls(null, ['/api/ai-lookup']), ['/api/ai-lookup']);
    assert.deepEqual(missingExpectedCalls(['/api/ai-lookup'], undefined), []);
  });

  test('duplicate expected paths are deduped in the result', () => {
    const observed = [];
    const expected = ['/api/ai-lookup', '/api/ai-lookup'];
    assert.deepEqual(missingExpectedCalls(observed, expected), ['/api/ai-lookup']);
  });
});
