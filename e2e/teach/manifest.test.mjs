// e2e/teach/manifest.test.mjs
//
// Points the knowledge/manifest modules at an isolated temp directory via
// TEACH_KNOWLEDGE_BASE so tests never touch the real testing/artifacts dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'teach-manifest-'));
await fs.writeFile(
  path.join(tmpBase, 'package.json'),
  JSON.stringify({ name: 'temp-fixture', version: '9.9.9' }),
  'utf8'
);
process.env.TEACH_KNOWLEDGE_BASE = tmpBase;

const {
  MANIFEST_STATUSES,
  createManifest,
  readManifest,
  recordCreated,
  setStatus,
  addNote,
} = await import('./manifest.mjs');

test('createManifest creates the run dir and an initial started manifest', async () => {
  const manifest = await createManifest('run-abc', {
    target: 'http://localhost:3300',
    personas: ['persona-a', 'persona-b'],
  });

  assert.equal(manifest.runId, 'run-abc');
  assert.equal(manifest.status, 'started');
  assert.equal(manifest.target, 'http://localhost:3300');
  assert.deepEqual(manifest.personas, ['persona-a', 'persona-b']);
  assert.equal(manifest.completedAt, null);
  assert.deepEqual(manifest.created, { accounts: [], businesses: [], docs: [] });
  assert.equal(manifest.teachBotVersion, '9.9.9');
  assert.deepEqual(manifest.notes, []);
  assert.ok(manifest.startedAt);
});

test('readManifest round-trips what createManifest wrote', async () => {
  await createManifest('run-roundtrip', { target: 't', personas: [] });
  const read = await readManifest('run-roundtrip');
  assert.equal(read.runId, 'run-roundtrip');
  assert.equal(read.status, 'started');
});

test('setStatus enforces MANIFEST_STATUSES and sets completedAt on terminal states', async () => {
  await createManifest('run-status', { target: 't', personas: [] });

  const stillRunning = await setStatus('run-status', 'started');
  assert.equal(stillRunning.completedAt, null);

  const completed = await setStatus('run-status', 'completed');
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);

  await assert.rejects(() => setStatus('run-status', 'bogus-status'), /invalid status/);
  assert.deepEqual(MANIFEST_STATUSES, ['started', 'completed', 'failed', 'aborted']);
});

test('recordCreated appends entries per kind', async () => {
  await createManifest('run-created', { target: 't', personas: [] });

  await recordCreated('run-created', 'accounts', { id: 'acc-1', email: 'a@example.com' });
  await recordCreated('run-created', 'businesses', { id: 'biz-1', label: 'Test Shop' });
  await recordCreated('run-created', 'docs', { id: 'doc-1' });

  const manifest = await readManifest('run-created');
  assert.deepEqual(manifest.created.accounts, [{ id: 'acc-1', email: 'a@example.com' }]);
  assert.deepEqual(manifest.created.businesses, [{ id: 'biz-1', label: 'Test Shop' }]);
  assert.deepEqual(manifest.created.docs, [{ id: 'doc-1' }]);

  await assert.rejects(() => recordCreated('run-created', 'nope', {}), /unknown kind/);
});

test('recordCreated throws on secret-shaped fields and never persists them', async () => {
  await createManifest('run-secret', { target: 't', personas: [] });

  await assert.rejects(
    () => recordCreated('run-secret', 'accounts', { id: 'acc-2', password: 'hunter2' }),
    /secret\/credential/
  );
  await assert.rejects(
    () => recordCreated('run-secret', 'accounts', { id: 'acc-3', authToken: 'abc.def.ghi' }),
    /secret\/credential/
  );
  await assert.rejects(
    () => recordCreated('run-secret', 'accounts', { id: 'acc-4', apiKey: 'sk-live-xxx' }),
    /secret\/credential/
  );

  const manifest = await readManifest('run-secret');
  assert.deepEqual(manifest.created.accounts, []);

  // Falsy/absent secret-shaped keys are fine (e.g. explicitly cleared field).
  await recordCreated('run-secret', 'accounts', { id: 'acc-5', password: '' });
  const manifest2 = await readManifest('run-secret');
  assert.equal(manifest2.created.accounts.length, 1);
  assert.equal(manifest2.created.accounts[0].id, 'acc-5');
});

test('addNote appends to notes', async () => {
  await createManifest('run-notes', { target: 't', personas: [] });
  await addNote('run-notes', 'first note');
  await addNote('run-notes', 'second note');
  const manifest = await readManifest('run-notes');
  assert.deepEqual(manifest.notes, ['first note', 'second note']);
});
