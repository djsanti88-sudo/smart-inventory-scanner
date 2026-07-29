// e2e/teach/windowBatching.test.mjs
//
// Unit tests for the pure persona-batching logic used by teach.mjs's runLive()
// to cap concurrently VISIBLE headed windows. Owner requirement: never show
// more than 2 headed windows at once - if more than 2 personas run, run them
// in batches of at most 2 (split-screen left/right), never all N at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { batchPersonas, MAX_CONCURRENT_WINDOWS } from './teach.mjs';

test('MAX_CONCURRENT_WINDOWS defaults to 2', () => {
  assert.equal(MAX_CONCURRENT_WINDOWS, 2);
});

test('batchPersonas: 3 personas with maxConcurrent=2 yields batches [2, 1]', () => {
  const batches = batchPersonas(['tire', 'cstore', 'supp'], 2);
  assert.deepEqual(batches, [['tire', 'cstore'], ['supp']]);
});

test('batchPersonas: every batch has length <= maxConcurrent', () => {
  const batches = batchPersonas(['a', 'b', 'c', 'd', 'e'], 2);
  for (const batch of batches) {
    assert.ok(batch.length <= 2, `batch ${JSON.stringify(batch)} exceeds max of 2`);
  }
});

test('batchPersonas: flattening all batches reproduces the original list in order', () => {
  const input = ['a', 'b', 'c', 'd', 'e'];
  const batches = batchPersonas(input, 2);
  assert.deepEqual(batches.flat(), input);
});

test('batchPersonas: exactly maxConcurrent items yields a single batch', () => {
  const batches = batchPersonas(['a', 'b'], 2);
  assert.deepEqual(batches, [['a', 'b']]);
});

test('batchPersonas: fewer than maxConcurrent items yields a single partial batch', () => {
  const batches = batchPersonas(['a'], 2);
  assert.deepEqual(batches, [['a']]);
});

test('batchPersonas: empty list yields no batches', () => {
  const batches = batchPersonas([], 2);
  assert.deepEqual(batches, []);
});

test('batchPersonas: defaults to MAX_CONCURRENT_WINDOWS when maxConcurrent is omitted', () => {
  const batches = batchPersonas(['a', 'b', 'c']);
  assert.deepEqual(batches, [['a', 'b'], ['c']]);
});

test('batchPersonas: never exceeds maxConcurrent even if maxConcurrent=1', () => {
  const batches = batchPersonas(['a', 'b', 'c'], 1);
  assert.deepEqual(batches, [['a'], ['b'], ['c']]);
});
