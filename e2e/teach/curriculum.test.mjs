// e2e/teach/curriculum.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  computeRunNumber,
  masteredFrom,
  selectLessons,
  pickExploration,
  loadLessons,
} from './curriculum.mjs';

describe('computeRunNumber', () => {
  test('empty history -> run 1', () => {
    assert.equal(computeRunNumber([]), 1);
  });

  test('two prior runs -> run 3', () => {
    assert.equal(computeRunNumber([{}, {}]), 3);
  });

  test('non-array history -> run 1', () => {
    assert.equal(computeRunNumber(undefined), 1);
  });
});

describe('masteredFrom', () => {
  test('collects ids with pass:true across multiple runs', () => {
    const history = [
      { runId: 'r1', results: [{ id: 'a', pass: true }, { id: 'b', pass: false }] },
      { runId: 'r2', results: [{ id: 'c', pass: true }] },
    ];
    const mastered = masteredFrom(history);
    assert.equal(mastered.has('a'), true);
    assert.equal(mastered.has('c'), true);
    assert.equal(mastered.has('b'), false);
  });

  test('ignores failed results', () => {
    const history = [{ results: [{ id: 'x', pass: false }] }];
    assert.equal(masteredFrom(history).size, 0);
  });

  test('empty/missing history -> empty set', () => {
    assert.equal(masteredFrom([]).size, 0);
    assert.equal(masteredFrom(undefined).size, 0);
  });
});

describe('selectLessons', () => {
  const allLessons = [
    { id: 'l1', level: 1 },
    { id: 'l2', level: 2 },
    { id: 'l3', level: 4 },
    { id: 'l4', level: 4 },
    { id: 'l5', level: 7 },
  ];

  test('run 1 selects only level-1 lessons', () => {
    const selected = selectLessons(allLessons, { runNumber: 1 });
    assert.deepEqual(selected.map((l) => l.id), ['l1']);
  });

  test('run 4 selects levels 1..4 sorted by level then id', () => {
    const selected = selectLessons(allLessons, { runNumber: 4 });
    assert.deepEqual(selected.map((l) => l.id), ['l1', 'l2', 'l3', 'l4']);
  });

  test('locked (higher-level) lessons are excluded', () => {
    const selected = selectLessons(allLessons, { runNumber: 4 });
    assert.ok(!selected.some((l) => l.id === 'l5'));
  });
});

describe('pickExploration', () => {
  const allLessons = [
    { id: 'e1', level: 3, explore: true },
    { id: 'e2', level: 5, explore: true },
    { id: 'n1', level: 2, explore: false },
  ];

  test('cycles deterministically by runNumber', () => {
    const mastered = new Set();
    const pick1 = pickExploration(allLessons, { runNumber: 0, mastered });
    const pick2 = pickExploration(allLessons, { runNumber: 1, mastered });
    assert.equal(pick1.id, 'e1');
    assert.equal(pick2.id, 'e2');
  });

  test('skips mastered lessons', () => {
    const mastered = new Set(['e1']);
    const pick = pickExploration(allLessons, { runNumber: 0, mastered });
    assert.equal(pick.id, 'e2');
  });

  test('returns null when the exploration pool is empty', () => {
    const nonExplore = [{ id: 'n1', level: 2, explore: false }];
    assert.equal(pickExploration(nonExplore, { runNumber: 0, mastered: new Set() }), null);
  });

  test('returns null when everything explorable is mastered', () => {
    const mastered = new Set(['e1', 'e2']);
    assert.equal(pickExploration(allLessons, { runNumber: 0, mastered }), null);
  });
});

describe('loadLessons', () => {
  test('tolerates a missing lessons directory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'teach-curriculum-'));
    const missingDir = path.join(tmp, 'does-not-exist');
    try {
      const lessons = await loadLessons(missingDir);
      assert.deepEqual(lessons, []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('tolerates an empty lessons directory', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'teach-curriculum-'));
    try {
      const lessons = await loadLessons(tmp);
      assert.deepEqual(lessons, []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
