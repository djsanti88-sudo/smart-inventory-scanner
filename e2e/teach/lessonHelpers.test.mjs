// e2e/teach/lessonHelpers.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildWedgeKeys, median, feedRowsFromCount } from './lessonHelpers.mjs';

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
