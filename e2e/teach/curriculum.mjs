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

/**
 * Resolves an explicit `--lesson` request list (each entry either a numeric
 * level string like "7" or a lesson id/slug like "live-decode-ladder-trace")
 * against the full lesson set. Pure function, no side effects.
 *
 * - A numeric-level request selects every lesson at that level.
 * - An id/slug request selects the single matching lesson.
 * - Results are deduped (a lesson matched by both a level and its own id
 *   only appears once) and returned sorted by level then id, matching the
 *   ordering used by selectLessons/buildPlan.
 * - Any request that resolves to zero lessons makes the whole result
 *   ok:false; `unknown` lists every such bad request (in the order first
 *   seen), and `plan` is [] so callers fail fast before doing anything else.
 *
 * @param {Array<{ id: string, level: number }>} allLessons
 * @param {string[]} requested - raw --lesson values, already split on commas
 * @returns {{ ok: boolean, plan: Array, unknown: string[] }}
 */
export function planForLessons(allLessons, requested) {
  const lessons = Array.isArray(allLessons) ? allLessons : [];
  const requestList = Array.isArray(requested) ? requested : [];

  if (requestList.length === 0) {
    return { ok: true, plan: [], unknown: [] };
  }

  const byLevel = new Map();
  const byId = new Map();
  for (const lesson of lessons) {
    if (!lesson) continue;
    if (typeof lesson.level === 'number') {
      const key = String(lesson.level);
      if (!byLevel.has(key)) byLevel.set(key, []);
      byLevel.get(key).push(lesson);
    }
    if (typeof lesson.id === 'string') {
      byId.set(lesson.id, lesson);
    }
  }

  const unknown = [];
  const matched = new Map();
  for (const raw of requestList) {
    const key = String(raw).trim();
    if (key.length === 0) continue;
    const isNumeric = /^\d+$/.test(key);
    const levelMatches = isNumeric ? byLevel.get(key) : null;
    const idMatch = byId.get(key);
    if (levelMatches && levelMatches.length > 0) {
      for (const lesson of levelMatches) matched.set(lesson.id, lesson);
    } else if (idMatch) {
      matched.set(idMatch.id, idMatch);
    } else {
      unknown.push(key);
    }
  }

  if (unknown.length > 0) {
    return { ok: false, plan: [], unknown };
  }

  const plan = [...matched.values()].sort(
    (a, b) => (a.level - b.level) || String(a.id).localeCompare(String(b.id))
  );
  return { ok: true, plan, unknown: [] };
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
