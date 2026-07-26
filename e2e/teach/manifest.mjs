// e2e/teach/manifest.mjs
//
// Per-run manifest for Teach Bot: tracks what a run created (accounts,
// businesses, docs) so a crashed run can be cleaned up, and the run's
// lifecycle status for crash recovery.
//
// Hard rule: never persist secrets. recordCreated() rejects any entry whose
// keys look like a credential (password/token/secret/cookie/etc).

import path from 'node:path';
import fs from 'node:fs/promises';
import { PATHS, atomicWriteFile } from './knowledge.mjs';

export const MANIFEST_STATUSES = ['started', 'completed', 'failed', 'aborted'];

const SECRET_KEY_PATTERN = /pass|password|token|secret|cookie|credential|apikey|api_key|authorization/i;

// Concurrent callers (e.g. Promise.all across personas in teach.mjs) can each
// read-modify-write RUN_MANIFEST.json for the SAME runId at the same time,
// which loses updates (last writer wins, earlier writes vanish). A promise-
// chain mutex serializes every mutation onto a single queue so read-modify-
// write bodies never interleave, while keeping each function's return value
// and async signature identical.
let _chain = Promise.resolve();
function withManifestLock(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

function runDir(runId) {
  return path.join(PATHS.artifactsDir, runId);
}

function manifestPath(runId) {
  return path.join(runDir(runId), 'RUN_MANIFEST.json');
}

async function readPackageVersion() {
  try {
    const raw = await fs.readFile(path.join(PATHS.repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

async function readManifestRaw(runId) {
  const raw = await fs.readFile(manifestPath(runId), 'utf8');
  return JSON.parse(raw);
}

async function writeManifestRaw(runId, manifest) {
  await atomicWriteFile(manifestPath(runId), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function createManifest(runId, { target, personas } = {}) {
  await fs.mkdir(runDir(runId), { recursive: true });
  const manifest = {
    runId,
    status: 'started',
    target: target ?? null,
    personas: personas ?? [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    created: { accounts: [], businesses: [], docs: [] },
    teachBotVersion: await readPackageVersion(),
    notes: [],
  };
  await writeManifestRaw(runId, manifest);
  return manifest;
}

export async function readManifest(runId) {
  return readManifestRaw(runId);
}

/**
 * Throws if `entry` contains any key (own, enumerable) that looks like a
 * credential and has a truthy value - so a caller can never persist a
 * secret into the manifest.
 */
function assertNoSecrets(entry) {
  if (!entry || typeof entry !== 'object') return;
  for (const [key, value] of Object.entries(entry)) {
    if (SECRET_KEY_PATTERN.test(key) && value) {
      throw new Error(
        `recordCreated: refusing to store field "${key}" - looks like a secret/credential`
      );
    }
  }
}

export async function recordCreated(runId, kind, entry) {
  if (!['accounts', 'businesses', 'docs'].includes(kind)) {
    throw new Error(`recordCreated: unknown kind "${kind}"`);
  }
  assertNoSecrets(entry);
  return withManifestLock(async () => {
    const manifest = await readManifestRaw(runId);
    manifest.created[kind] = [...(manifest.created[kind] ?? []), entry];
    await writeManifestRaw(runId, manifest);
    return manifest;
  });
}

export async function setStatus(runId, status) {
  if (!MANIFEST_STATUSES.includes(status)) {
    throw new Error(`setStatus: invalid status "${status}"`);
  }
  return withManifestLock(async () => {
    const manifest = await readManifestRaw(runId);
    manifest.status = status;
    if (status === 'completed' || status === 'failed' || status === 'aborted') {
      manifest.completedAt = new Date().toISOString();
    }
    await writeManifestRaw(runId, manifest);
    return manifest;
  });
}

export async function addNote(runId, note) {
  return withManifestLock(async () => {
    const manifest = await readManifestRaw(runId);
    manifest.notes = [...(manifest.notes ?? []), note];
    await writeManifestRaw(runId, manifest);
    return manifest;
  });
}
