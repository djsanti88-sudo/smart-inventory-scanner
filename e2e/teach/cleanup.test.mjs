// e2e/teach/cleanup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planCleanup, runCleanup } from './cleanup.mjs';

function makeManifest(overrides = {}) {
  return {
    runId: 'run-1',
    status: 'completed',
    target: 'mock',
    created: {
      accounts: [{ email: 'a@example.com' }],
      businesses: [{ path: 'businesses/biz-1' }],
      docs: [{ path: 'businesses/biz-1/products/prod-1' }],
    },
    ...overrides,
  };
}

test('parseArgs: missing run-id throws', () => {
  assert.throws(() => parseArgs([]), /--run-id/);
  assert.throws(() => parseArgs(['--dry-run']), /--run-id/);
});

test('parseArgs: --dry-run default true when neither flag given', () => {
  const result = parseArgs(['--run-id', 'run-1']);
  assert.equal(result.runId, 'run-1');
  assert.equal(result.dryRun, true);
  assert.equal(result.confirm, false);
});

test('parseArgs: explicit --dry-run sets dryRun true', () => {
  const result = parseArgs(['--run-id', 'run-1', '--dry-run']);
  assert.equal(result.dryRun, true);
  assert.equal(result.confirm, false);
});

test('parseArgs: --confirm sets confirm true and dryRun false', () => {
  const result = parseArgs(['--run-id', 'run-1', '--confirm']);
  assert.equal(result.confirm, true);
  assert.equal(result.dryRun, false);
});

test('parseArgs: both --dry-run and --confirm -> confirm wins', () => {
  const result = parseArgs(['--run-id', 'run-1', '--dry-run', '--confirm']);
  assert.equal(result.confirm, true);
  assert.equal(result.dryRun, false);
});

test('planCleanup: pulls only manifest.created IDs', () => {
  const manifest = makeManifest();
  const plan = planCleanup(manifest);
  assert.deepEqual(plan.accounts, manifest.created.accounts);
  assert.deepEqual(plan.businesses, manifest.created.businesses);
  assert.deepEqual(plan.docs, manifest.created.docs);
  assert.match(plan.summary, /run-1/);
  assert.match(plan.summary, /1 account/);
});

test('planCleanup: null manifest throws no-blind-sweep error', () => {
  assert.throws(
    () => planCleanup(null, 'run-xyz'),
    /No manifest for run run-xyz - refusing to clean \(no blind sweeps\)\./
  );
});

test('planCleanup: malformed manifest (no created) throws', () => {
  assert.throws(() => planCleanup({ runId: 'run-2' }, 'run-2'), /refusing to clean/);
});

test('runCleanup dry-run: never calls deleteFirestoreDoc, returns planned:true', async () => {
  const manifest = makeManifest();
  let deleteCalls = 0;
  const logs = [];
  const deps = {
    readManifest: async () => manifest,
    deleteFirestoreDoc: async () => {
      deleteCalls += 1;
    },
    log: (msg) => logs.push(msg),
  };

  const result = await runCleanup({ runId: 'run-1', dryRun: true, confirm: false }, deps);

  assert.equal(result.planned, true);
  assert.equal(deleteCalls, 0);
  assert.ok(logs.length > 0);
  assert.deepEqual(result.plan.accounts, manifest.created.accounts);
});

test('runCleanup confirm: deletes each business+doc once, collects accounts as manual removal', async () => {
  const manifest = makeManifest();
  let deleteCalls = 0;
  const deletedPaths = [];
  const logs = [];
  const deps = {
    readManifest: async () => manifest,
    deleteFirestoreDoc: async (path) => {
      deleteCalls += 1;
      deletedPaths.push(path);
    },
    log: (msg) => logs.push(msg),
  };

  const result = await runCleanup({ runId: 'run-1', dryRun: false, confirm: true }, deps);

  // 1 business + 1 doc = 2 deleteFirestoreDoc calls; never called for accounts
  assert.equal(deleteCalls, 2);
  assert.deepEqual(deletedPaths.sort(), ['businesses/biz-1', 'businesses/biz-1/products/prod-1'].sort());
  assert.deepEqual(result.deleted.sort(), deletedPaths.sort());
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.manualAuthRemoval, ['a@example.com']);
});

test('runCleanup confirm: collects failures without throwing', async () => {
  const manifest = makeManifest();
  const deps = {
    readManifest: async () => manifest,
    deleteFirestoreDoc: async (path) => {
      throw new Error(`boom: ${path}`);
    },
    log: () => {},
  };

  const result = await runCleanup({ runId: 'run-1', dryRun: false, confirm: true }, deps);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[0].error, /boom/);
});

test('runCleanup with missing manifest throws refusing-to-clean error', async () => {
  const deps = {
    readManifest: async () => null,
    deleteFirestoreDoc: async () => {},
    log: () => {},
  };

  await assert.rejects(
    () => runCleanup({ runId: 'run-missing', dryRun: true, confirm: false }, deps),
    /No manifest for run run-missing - refusing to clean \(no blind sweeps\)\./
  );
});

test('runCleanup with readManifest that throws also refuses to clean', async () => {
  const deps = {
    readManifest: async () => {
      throw new Error('ENOENT');
    },
    deleteFirestoreDoc: async () => {},
    log: () => {},
  };

  await assert.rejects(
    () => runCleanup({ runId: 'run-missing2', dryRun: true, confirm: false }, deps),
    /No manifest for run run-missing2/
  );
});
