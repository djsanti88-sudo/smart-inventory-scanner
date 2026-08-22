import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compareIdentity, loadOracle } from './oracle.mjs';

describe('compareIdentity', () => {
  test('exact name+brand match', () => {
    const r = compareIdentity(
      { name: 'Falken Wildpeak A T3w 265/70R17', brand: 'Falken' },
      { name: 'Falken Wildpeak A T3w 265/70R17', brand: 'Falken' }
    );
    assert.equal(r.match, true);
    assert.equal(typeof r.reason, 'string');
  });

  test('brand-only match (name differs but same brand)', () => {
    const r = compareIdentity(
      { name: 'Some Truck Tire', brand: 'Falken' },
      { name: 'Falken Wildpeak A T3w 265/70R17', brand: 'Falken' }
    );
    assert.equal(r.match, true);
    assert.match(r.reason, /brand/i);
  });

  test('token-overlap match (significant shared name tokens, no brand field)', () => {
    const r = compareIdentity(
      { name: 'Wildpeak A T3w 265/70R17', brand: '' },
      { name: 'Falken Wildpeak A T3w 265/70R17', brand: 'Falken' }
    );
    assert.equal(r.match, true);
    assert.match(r.reason, /token|overlap|name/i);
  });

  test('empty observed vs non-empty expected is a definite miss', () => {
    const r = compareIdentity(
      { name: '', brand: '' },
      { name: 'BIC Pocket Lighter', brand: 'BIC' }
    );
    assert.equal(r.match, false);
    assert.match(r.reason, /empty|missing|no observed/i);
  });

  test('punctuation and case differences still match', () => {
    const r = compareIdentity(
      { name: 'bic  pocket-lighter!', brand: 'bic' },
      { name: 'BIC Pocket Lighter', brand: 'BIC' }
    );
    assert.equal(r.match, true);
  });

  test('clear non-match (different brand, no token overlap)', () => {
    const r = compareIdentity(
      { name: 'Toyo Proxes ST III', brand: 'Toyo' },
      { name: 'BIC Pocket Lighter', brand: 'BIC' }
    );
    assert.equal(r.match, false);
    assert.match(r.reason, /no match|mismatch|differ/i);
  });

  test('accepts plain strings on both sides', () => {
    const r = compareIdentity('BIC Pocket Lighter', 'BIC Pocket Lighter');
    assert.equal(r.match, true);
  });

  test('accepts a string observed vs object expected', () => {
    const r = compareIdentity('Falken Wildpeak A T3w', { name: 'Falken Wildpeak A T3w 265/70R17', brand: 'Falken' });
    assert.equal(r.match, true);
  });

  test('both empty is not counted as a miss (nothing expected)', () => {
    const r = compareIdentity({ name: '', brand: '' }, { name: '', brand: '' });
    // No expected identity to check against -> not a miss.
    assert.equal(r.match, true);
  });

  test('non-empty observed vs empty expected is not a miss', () => {
    const r = compareIdentity(
      { name: 'Anything At All', brand: 'Anything' },
      { name: '', brand: '' }
    );
    assert.equal(r.match, true);
  });

  test('single shared stopword-ish token does not force a match', () => {
    const r = compareIdentity(
      { name: 'Blue Coffee Mug', brand: '' },
      { name: 'Red Tea Kettle', brand: '' }
    );
    assert.equal(r.match, false);
  });

  test('handles null / undefined inputs without throwing', () => {
    const r1 = compareIdentity(null, { name: 'BIC Pocket Lighter', brand: 'BIC' });
    assert.equal(r1.match, false);
    const r2 = compareIdentity(undefined, undefined);
    assert.equal(typeof r2.match, 'boolean');
    assert.equal(typeof r2.reason, 'string');
  });
});

describe('loadOracle', () => {
  test('happy path: reads a JSON array from a given path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-test-'));
    const p = join(dir, 'oracle-codes.json');
    const fixture = [
      { code: '070330645936', expectedName: 'BIC Pocket Lighter', expectedBrand: 'BIC', source: 'verified fixture' },
    ];
    writeFileSync(p, JSON.stringify(fixture), 'utf8');
    try {
      const loaded = loadOracle(p);
      assert.deepEqual(loaded, fixture);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing file returns [] instead of throwing', () => {
    const loaded = loadOracle(join(tmpdir(), 'definitely-does-not-exist-oracle-xyz.json'));
    assert.deepEqual(loaded, []);
  });

  test('malformed JSON returns [] instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-test-'));
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not valid json', 'utf8');
    try {
      assert.deepEqual(loadOracle(p), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-array JSON returns [] (tolerant)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-test-'));
    const p = join(dir, 'obj.json');
    writeFileSync(p, JSON.stringify({ not: 'an array' }), 'utf8');
    try {
      assert.deepEqual(loadOracle(p), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
