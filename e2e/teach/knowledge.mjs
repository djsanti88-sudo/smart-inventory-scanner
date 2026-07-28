// e2e/teach/knowledge.mjs
//
// Teach Bot knowledge-file I/O: atomic read/merge/write of the shared
// "app knowledge" files used by the multi-persona test harness.
//
// Hard rule: LOCKED_REQUIREMENTS.md is sacred. It is read-only from code.
// Nothing in this module (or any caller that reuses atomicWriteFile) may
// write to it - assertNotLocked() is enforced at the top of every write path.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

// e2e/teach/knowledge.mjs -> up two levels -> repo root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Build the resolved PATHS object for a given repo root.
 * Exposed so tests can point the whole module at a temp directory via
 * the TEACH_KNOWLEDGE_BASE env var or by importing with a custom root.
 */
function buildPaths(repoRoot) {
  const appKnowledgeDir = path.join(repoRoot, 'testing', 'app-knowledge');
  const artifactsDir = path.join(repoRoot, 'testing', 'artifacts');
  const specsDir = path.join(repoRoot, 'testing', 'specs');
  const candidatesDir = path.join(repoRoot, 'testing', 'tests', 'candidates');
  const permanentDir = path.join(repoRoot, 'testing', 'tests', 'permanent');
  return {
    repoRoot,
    appKnowledgeDir,
    locked: path.join(appKnowledgeDir, 'LOCKED_REQUIREMENTS.md'),
    appExpert: path.join(appKnowledgeDir, 'APP_EXPERT.md'),
    coverage: path.join(appKnowledgeDir, 'COVERAGE_MATRIX.json'),
    runHistory: path.join(appKnowledgeDir, 'RUN_HISTORY.jsonl'),
    discoveries: path.join(appKnowledgeDir, 'DISCOVERIES.md'),
    bugs: path.join(appKnowledgeDir, 'BUGS.md'),
    artifactsDir,
    specsDir,
    candidatesDir,
    permanentDir,
  };
}

// TEACH_KNOWLEDGE_BASE lets tests (and any future harness invocation) redirect
// every path under this module to an isolated temp directory instead of the
// real repo root, so tests never touch the real testing/app-knowledge files.
const REPO_ROOT = process.env.TEACH_KNOWLEDGE_BASE
  ? path.resolve(process.env.TEACH_KNOWLEDGE_BASE)
  : DEFAULT_REPO_ROOT;

export const PATHS = buildPaths(REPO_ROOT);

export const LOCKED_PATH = PATHS.locked;

/**
 * Refuse to let any write path target LOCKED_REQUIREMENTS.md.
 * Compares resolved absolute paths so relative/case/slash variants can't slip past.
 */
export async function assertNotLocked(absPath) {
  const resolved = path.resolve(absPath);
  if (resolved === path.resolve(PATHS.locked)) {
    throw new Error('LOCKED_REQUIREMENTS.md is sacred and must never be written by code');
  }
}

/**
 * Atomically write content to absPath: write to a unique temp file in the
 * same directory, then rename over the target. Rename is atomic on the same
 * volume, so readers never observe a partial write.
 */
export async function atomicWriteFile(absPath, content) {
  await assertNotLocked(absPath);
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `${path.basename(absPath)}.${process.pid}.${process.hrtime.bigint()}.tmp`
  );
  await fs.writeFile(tmpPath, content, 'utf8');
  try {
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    // Best-effort cleanup so a failed rename never leaves the tmp file behind.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function readTextOrDefault(absPath, fallback) {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readJsonOrDefault(absPath, fallback) {
  const raw = await readTextOrDefault(absPath, null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readJsonlOrDefault(absPath) {
  const raw = await readTextOrDefault(absPath, '');
  if (!raw) return [];
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines rather than throwing; readKnowledge must never throw.
    }
  }
  return out;
}

export async function readLocked() {
  return readTextOrDefault(PATHS.locked, '');
}

/**
 * Read every knowledge file, returning sensible defaults for anything
 * missing. Never throws.
 */
export async function readKnowledge() {
  const [lockedText, appExpert, coverage, runHistory, discoveries, bugs] = await Promise.all([
    readTextOrDefault(PATHS.locked, ''),
    readTextOrDefault(PATHS.appExpert, ''),
    readJsonOrDefault(PATHS.coverage, null),
    readJsonlOrDefault(PATHS.runHistory),
    readTextOrDefault(PATHS.discoveries, ''),
    readTextOrDefault(PATHS.bugs, ''),
  ]);
  return { lockedText, appExpert, coverage, runHistory, discoveries, bugs };
}

export async function writeAppExpert(text) {
  await atomicWriteFile(PATHS.appExpert, text);
}

export async function writeCoverage(obj) {
  await atomicWriteFile(PATHS.coverage, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Extract the leading integer from a COVERAGE_MATRIX lesson key like "10-reconcile-equal-and-different". */
export function leadingCoverageLevel(key) {
  const match = /^(\d+)-/.exec(key);
  return match ? Number(match[1]) : null;
}

function resultWasSkipped(result) {
  return Boolean(
    result?.skipped === true ||
    result?.learned?.skipped === true ||
    result?.isolationVectorsTested === 0 ||
    result?.learned?.isolationVectorsTested === 0
  );
}

function statusForResults(results) {
  if (!Array.isArray(results) || results.length === 0) return 'not_run';
  if (results.some((result) => !resultWasSkipped(result) && result?.pass === false)) return 'failed';
  if (results.some((result) => resultWasSkipped(result))) return 'skipped';
  return results.every((result) => result?.pass === true) ? 'covered' : 'failed';
}

/**
 * Merge a run's actual lesson results into COVERAGE_MATRIX.
 * A lesson is covered only when it executed and passed. Non-executed lessons
 * keep their prior status/run evidence instead of adopting this run id.
 */
export function updateCoverageForRun(coverage, plan, runId, results) {
  const base = coverage && typeof coverage === 'object' ? coverage : { lessons: {} };
  const next = JSON.parse(JSON.stringify(base));
  next.lessons = next.lessons && typeof next.lessons === 'object' ? next.lessons : {};
  next.updatedAt = new Date().toISOString();

  const plannedByLevel = new Map(
    (Array.isArray(plan) ? plan : [])
      .filter((lesson) => lesson && typeof lesson.level === 'number' && typeof lesson.id === 'string')
      .map((lesson) => [lesson.level, lesson])
  );
  const resultsById = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result.id !== 'string') continue;
    if (!resultsById.has(result.id)) resultsById.set(result.id, []);
    resultsById.get(result.id).push(result);
  }

  for (const key of Object.keys(next.lessons)) {
    const level = leadingCoverageLevel(key);
    const lesson = level === null ? null : plannedByLevel.get(level);
    const lessonResults = lesson ? resultsById.get(lesson.id) ?? [] : [];
    const status = statusForResults(lessonResults);
    if (status !== 'not_run') {
      next.lessons[key] = { status, lastRunId: runId };
    }
  }
  return next;
}

/**
 * Append one JSON object as a single line to RUN_HISTORY.jsonl.
 * Reads the existing content, appends the new line, and rewrites the whole
 * file atomically - safe because the orchestrator is the single writer.
 */
export async function appendRunHistory(entryObj) {
  const existing = await readTextOrDefault(PATHS.runHistory, '');
  const line = JSON.stringify(entryObj);
  const next = existing && existing.length > 0 && !existing.endsWith('\n')
    ? `${existing}\n${line}\n`
    : `${existing}${line}\n`;
  await atomicWriteFile(PATHS.runHistory, next);
}

async function appendMarkdownBlock(absPath, markdownBlock) {
  const existing = await readTextOrDefault(absPath, '');
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${separator}${markdownBlock}\n`;
  await atomicWriteFile(absPath, next);
}

export async function appendDiscoveries(markdownBlock) {
  await appendMarkdownBlock(PATHS.discoveries, markdownBlock);
}

export async function appendBugs(markdownBlock) {
  await appendMarkdownBlock(PATHS.bugs, markdownBlock);
}
