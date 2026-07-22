// e2e/teach/curriculum.mjs
//
// Pure lesson-selection logic + the dynamic lesson loader for the Teach Bot
// harness. Does NOT import app source or Playwright.
//
// ---------------------------------------------------------------------------
// THE LESSON CONTRACT
// ---------------------------------------------------------------------------
// Each file under lessons/*.mjs default-exports an object of this shape:
//
//   {
//     id: string,                 // unique, stable across runs
//     title: string,
//     level: number,              // integer 1..11 (curriculum difficulty tier)
//     explore: boolean = false,   // opt into rotating exploration selection
//     prereqs: string[] = [],     // other lesson ids this one assumes passed
//     async run(ctx) => {
//       pass: boolean,
//       findings: array,
//       learned: object,
//       notes: string,
//     },
//   }
//
// ctx passed to run() is:
//   {
//     page, persona, runId, baseURL, deploymentMode, limits,
//     h,        // lessonHelpers.mjs
//     ladder,   // ladder.mjs
//     sheets,   // sheets.mjs
//     triage,   // triage.mjs
//     artifactsDir,
//     recordFinding,
//   }
//
// loadLessons() enforces this contract at load time: a lesson file whose
// default export is missing id/level/run (or whose level is not an integer)
// is skipped with a console.warn rather than crashing the whole run.
export const LESSON_CONTRACT = {
  shape: {
    id: 'string (unique, stable)',
    title: 'string',
    level: 'integer 1..11',
    explore: 'boolean, default false',
    prereqs: 'string[], default []',
    run: 'async (ctx) => ({ pass, findings, learned, notes })',
  },
  ctx: [
    'page', 'persona', 'runId', 'baseURL', 'deploymentMode', 'limits',
    'h', 'ladder', 'sheets', 'triage', 'artifactsDir', 'recordFinding',
  ],
};

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The next run number given the run history so far (1-indexed).
 * @param {Array} runHistory
 */
export function computeRunNumber(runHistory) {
  return (Array.isArray(runHistory) ? runHistory.length : 0) + 1;
}

/**
 * The set of lesson ids that have passed at least once across any prior run.
 * @param {Array<{ runId?: string, results?: Array<{ id: string, pass: boolean }> }>} runHistory
 */
export function masteredFrom(runHistory) {
  const mastered = new Set();
  if (!Array.isArray(runHistory)) return mastered;
  for (const entry of runHistory) {
    const results = Array.isArray(entry?.results) ? entry.results : [];
    for (const result of results) {
      if (result && result.pass === true && typeof result.id === 'string') {
        mastered.add(result.id);
      }
    }
  }
  return mastered;
}

/**
 * Cumulative lesson selection: run N re-proves every lesson with
 * level <= N (levels beyond N are "locked" and excluded). Sorted ascending
 * by level then id for stable, deterministic ordering.
 * @param {Array<{ id: string, level: number }>} allLessons
 * @param {{ runNumber: number }} options
 */
export function selectLessons(allLessons, { runNumber }) {
  if (!Array.isArray(allLessons)) return [];
  return allLessons
    .filter((lesson) => lesson && typeof lesson.level === 'number' && lesson.level <= runNumber)
    .sort((a, b) => (a.level - b.level) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Deterministically pick one exploration-tagged lesson not yet mastered,
 * cycling by runNumber so repeated runs surface different exploration
 * lessons over time. Additive on top of selectLessons - never a replacement.
 * @param {Array<{ id: string, level: number, explore?: boolean }>} allLessons
 * @param {{ runNumber: number, mastered: Set<string> }} options
 */
export function pickExploration(allLessons, { runNumber, mastered }) {
  if (!Array.isArray(allLessons)) return null;
  const pool = allLessons
    .filter((lesson) => lesson && lesson.explore === true && !mastered.has(lesson.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (pool.length === 0) return null;
  const index = ((runNumber % pool.length) + pool.length) % pool.length;
  return pool[index];
}

function isValidLesson(candidate) {
  return Boolean(
    candidate &&
    typeof candidate.id === 'string' && candidate.id.length > 0 &&
    typeof candidate.level === 'number' && Number.isInteger(candidate.level) &&
    typeof candidate.run === 'function'
  );
}

/**
 * Dynamically import every *.mjs file in `dir`, collecting valid default
 * exports (per LESSON_CONTRACT) sorted by level. Tolerates a missing or
 * empty lessons directory (returns []). Invalid lesson files are skipped
 * with a console.warn rather than throwing.
 * @param {string|URL} [dir]
 */
export async function loadLessons(dir = new URL('./lessons/', import.meta.url)) {
  const dirPath = dir instanceof URL ? fileURLToPath(dir) : dir;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();

  const lessons = [];
  for (const file of files) {
    const fileUrl = new URL(file, dir instanceof URL ? dir : `file://${dirPath.replace(/\\/g, '/')}/`);
    try {
      const mod = await import(fileUrl.href);
      const candidate = mod.default;
      if (isValidLesson(candidate)) {
        lessons.push(candidate);
      } else {
        console.warn(`curriculum: skipping invalid lesson file (contract violation): ${file}`);
      }
    } catch (err) {
      console.warn(`curriculum: failed to load lesson file ${file}: ${err?.message ?? err}`);
    }
  }

  return lessons.sort((a, b) => (a.level - b.level) || String(a.id).localeCompare(String(b.id)));
}
