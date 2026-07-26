// e2e/teach/knowledge.test.mjs
//
// Points the whole knowledge module at an isolated temp directory via
// TEACH_KNOWLEDGE_BASE so tests never touch the real testing/app-knowledge
// files, then imports the module fresh (env var is read at module load).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'teach-knowledge-'));
process.env.TEACH_KNOWLEDGE_BASE = tmpBase;

const {
  PATHS,
  LOCKED_PATH,
  assertNotLocked,
  atomicWriteFile,
  readKnowledge,
  readLocked,
  writeAppExpert,
  writeCoverage,
  updateCoverageForRun,
  appendRunHistory,
  appendDiscoveries,
  appendBugs,
} = await import('./knowledge.mjs');

test('PATHS resolve under the overridden base, not the real repo', () => {
  assert.equal(PATHS.repoRoot, tmpBase);
  assert.equal(LOCKED_PATH, PATHS.locked);
  assert.ok(PATHS.locked.startsWith(tmpBase));
});

test('atomicWriteFile writes content, auto-creates parent dirs, leaves no .tmp file', async () => {
  const target = path.join(tmpBase, 'nested', 'deeper', 'file.txt');
  await atomicWriteFile(target, 'hello world');

  const content = await fs.readFile(target, 'utf8');
  assert.equal(content, 'hello world');

  const siblings = await fs.readdir(path.dirname(target));
  const tmpFiles = siblings.filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(tmpFiles, []);
});

test('assertNotLocked throws for the locked path', async () => {
  await assert.rejects(
    () => assertNotLocked(PATHS.locked),
    /LOCKED_REQUIREMENTS\.md is sacred/
  );
});

test('atomicWriteFile throws when targeting LOCKED_REQUIREMENTS.md and does not write it', async () => {
  await fs.rm(PATHS.locked, { force: true }).catch(() => {});
  await assert.rejects(
    () => atomicWriteFile(PATHS.locked, 'malicious overwrite'),
    /sacred/
  );
  await assert.rejects(() => fs.readFile(PATHS.locked, 'utf8'));
});

test('readKnowledge returns defaults when all files are missing', async () => {
  const emptyBase = await fs.mkdtemp(path.join(os.tmpdir(), 'teach-knowledge-empty-'));
  const prevEnv = process.env.TEACH_KNOWLEDGE_BASE;
  process.env.TEACH_KNOWLEDGE_BASE = emptyBase;
  // Re-import with a cache-busting query so this module picks up the new base.
  const mod = await import(`./knowledge.mjs?empty=${Date.now()}`);
  process.env.TEACH_KNOWLEDGE_BASE = prevEnv;

  const knowledge = await mod.readKnowledge();
  assert.equal(knowledge.lockedText, '');
  assert.equal(knowledge.appExpert, '');
  assert.equal(knowledge.coverage, null);
  assert.deepEqual(knowledge.runHistory, []);
  assert.equal(knowledge.discoveries, '');
  assert.equal(knowledge.bugs, '');
});

test('readLocked / writeAppExpert / writeCoverage round-trip', async () => {
  await fs.mkdir(PATHS.appKnowledgeDir, { recursive: true });
  await fs.writeFile(PATHS.locked, '# Locked rules\nDo not edit.\n', 'utf8');
  assert.equal(await readLocked(), '# Locked rules\nDo not edit.\n');

  await writeAppExpert('# App Expert\nSome notes.\n');
  const knowledge1 = await readKnowledge();
  assert.equal(knowledge1.appExpert, '# App Expert\nSome notes.\n');

  await writeCoverage({ flows: ['login', 'scan'], count: 2 });
  const knowledge2 = await readKnowledge();
  assert.deepEqual(knowledge2.coverage, { flows: ['login', 'scan'], count: 2 });
});

test('updateCoverageForRun marks skipped lesson results as skipped, not covered', () => {
  const coverage = {
    lessons: {
      '11-tenant-isolation-deep': { status: 'not_run', lastRunId: null },
    },
  };
  const plan = [{ id: 'tenant-isolation-deep', level: 11 }];
  const next = updateCoverageForRun(coverage, plan, 'run-skipped', [
    {
      id: 'tenant-isolation-deep',
      pass: true,
      skipped: true,
      learned: { isolationVectorsTested: 0 },
    },
  ]);

  assert.deepEqual(next.lessons['11-tenant-isolation-deep'], {
    status: 'skipped',
    lastRunId: 'run-skipped',
  });
});

test('updateCoverageForRun marks failed lesson results as failed', () => {
  const coverage = {
    lessons: {
      '2-scan-n-equals-count-n': { status: 'not_run', lastRunId: null },
    },
  };
  const plan = [{ id: 'scan-n-count-n', level: 2 }];
  const next = updateCoverageForRun(coverage, plan, 'run-failed', [
    { id: 'scan-n-count-n', pass: false },
  ]);

  assert.deepEqual(next.lessons['2-scan-n-equals-count-n'], {
    status: 'failed',
    lastRunId: 'run-failed',
  });
});

test('updateCoverageForRun preserves a lesson not executed in the run', () => {
  const coverage = {
    lessons: {
      '1-signup-first-scan': { status: 'covered', lastRunId: 'run-prior' },
      '4-offline-reconnect': { status: 'not_run', lastRunId: null },
    },
  };
  const plan = [
    { id: 'signup-first-scan', level: 1 },
    { id: 'offline-reconnect', level: 4 },
  ];
  const next = updateCoverageForRun(coverage, plan, 'run-current', [
    { id: 'round-reset', pass: false },
  ]);

  assert.deepEqual(next.lessons['1-signup-first-scan'], {
    status: 'covered',
    lastRunId: 'run-prior',
  });
  assert.deepEqual(next.lessons['4-offline-reconnect'], {
    status: 'not_run',
    lastRunId: null,
  });
});

test('appendRunHistory produces valid JSONL, one object per line', async () => {
  await fs.rm(PATHS.runHistory, { force: true }).catch(() => {});
  await appendRunHistory({ runId: 'run-1', status: 'completed' });
  await appendRunHistory({ runId: 'run-2', status: 'failed' });

  const raw = await fs.readFile(PATHS.runHistory, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].runId, 'run-1');
  assert.equal(parsed[1].runId, 'run-2');

  const knowledge = await readKnowledge();
  assert.equal(knowledge.runHistory.length, 2);
  assert.equal(knowledge.runHistory[1].status, 'failed');
});

test('readKnowledge skips malformed JSONL lines instead of throwing', async () => {
  await atomicWriteFile(PATHS.runHistory, '{"ok":true}\nnot json\n{"ok":false}\n');
  const knowledge = await readKnowledge();
  assert.deepEqual(knowledge.runHistory, [{ ok: true }, { ok: false }]);
});

test('appendDiscoveries / appendBugs append markdown blocks', async () => {
  await fs.rm(PATHS.discoveries, { force: true }).catch(() => {});
  await fs.rm(PATHS.bugs, { force: true }).catch(() => {});

  await appendDiscoveries('## Discovery 1\nFound X.');
  await appendDiscoveries('## Discovery 2\nFound Y.');
  const knowledge1 = await readKnowledge();
  assert.match(knowledge1.discoveries, /Discovery 1/);
  assert.match(knowledge1.discoveries, /Discovery 2/);

  await appendBugs('## Bug 1\nBroken Z.');
  const knowledge2 = await readKnowledge();
  assert.match(knowledge2.bugs, /Bug 1/);
});
