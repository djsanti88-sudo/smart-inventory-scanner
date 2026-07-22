// Pure Node ESM module for the Teach Bot Playwright harness.
// Turns a raw observation into a triaged finding, enforcing "a suspected app
// bug must reproduce twice before confirmed (unless unsafe to repeat)".
//
// Does NOT import app source.

export const TRIAGE_CLASSES = [
  "confirmed_app_bug",
  "probable_app_bug",
  "test_bug",
  "test_data_problem",
  "environment_problem",
  "flaky",
];

export const SEVERITIES = ["critical", "high", "medium", "low"];

/**
 * Attempt to reproduce a suspected defect by calling reproFn multiple times.
 * If unsafe to repeat, short-circuits without calling reproFn.
 * @param {() => Promise<boolean> | boolean} reproFn resolves/returns truthy when the defect reproduced
 * @param {{ times?: number, unsafe?: boolean }} [options]
 */
export async function confirmReproduction(reproFn, { times = 2, unsafe = false } = {}) {
  if (unsafe) {
    return { reproduced: false, attempts: 0, unsafe: true };
  }

  const successes = [];
  for (let i = 0; i < times; i += 1) {
    let result = false;
    try {
      result = Boolean(await reproFn());
    } catch {
      result = false;
    }
    successes.push(result);
  }

  const reproduced = successes.length === times && successes.every(Boolean);

  return { reproduced, attempts: times, successes };
}

/**
 * Classify a failure observation into a triage class. Order matters - first
 * matching rule wins.
 * @param {{
 *   consoleErrors?: any[],
 *   failedRequests?: any[],
 *   selectorMissing?: boolean,
 *   assertionFailed?: boolean,
 *   reproduced?: boolean,
 *   unsafe?: boolean,
 *   envSignal?: boolean,
 * }} observation
 */
export function classifyFailure({
  consoleErrors = [],
  failedRequests = [],
  selectorMissing = false,
  assertionFailed = false,
  reproduced = false,
  unsafe = false,
  envSignal = false,
} = {}) {
  const hasConsoleErrors = Array.isArray(consoleErrors) && consoleErrors.length > 0;
  const hasFailedRequests = Array.isArray(failedRequests) && failedRequests.length > 0;
  const hasFailureSignal = assertionFailed || hasConsoleErrors || hasFailedRequests;

  if (envSignal) return "environment_problem";

  if (selectorMissing && !hasConsoleErrors && !hasFailedRequests) return "test_bug";

  if (reproduced && (hasConsoleErrors || hasFailedRequests || assertionFailed)) {
    return "confirmed_app_bug";
  }

  if (hasFailureSignal && unsafe) return "probable_app_bug";

  if (hasFailureSignal && !reproduced) return "probable_app_bug";

  return "flaky";
}

/**
 * Build a normalized finding object.
 * @param {{
 *   title: string,
 *   category: string,
 *   severity: string,
 *   lesson?: string,
 *   persona?: string,
 *   repro?: string,
 *   expected?: string,
 *   actual?: string,
 *   evidence?: { screenshot?: string, trace?: string, video?: string, consoleLog?: string, networkLog?: string },
 *   triageClass: string,
 *   customerImpact?: string,
 *   options?: any[],
 *   locked?: boolean,
 * }} input
 */
export function buildFinding({
  title,
  category,
  severity,
  lesson,
  persona,
  repro,
  expected,
  actual,
  evidence = {},
  triageClass,
  customerImpact,
  options = [],
  locked = false,
}) {
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`Invalid severity: ${severity}. Must be one of: ${SEVERITIES.join(", ")}`);
  }
  if (!TRIAGE_CLASSES.includes(triageClass)) {
    throw new Error(`Invalid triageClass: ${triageClass}. Must be one of: ${TRIAGE_CLASSES.join(", ")}`);
  }

  const normalizedOptions = Array.isArray(options) ? options : [];
  const needsSolutionOptions = normalizedOptions.length === 0;

  // Never include secrets - evidence is limited to file references only.
  const evidenceFields = {
    screenshot: evidence?.screenshot ?? null,
    trace: evidence?.trace ?? null,
    video: evidence?.video ?? null,
    consoleLog: evidence?.consoleLog ?? null,
    networkLog: evidence?.networkLog ?? null,
  };

  return {
    title,
    category,
    severity,
    lesson: lesson ?? null,
    persona: persona ?? null,
    repro: repro ?? null,
    expected: expected ?? null,
    actual: actual ?? null,
    evidence: evidenceFields,
    triageClass,
    customerImpact: customerImpact ?? null,
    options: normalizedOptions,
    needsSolutionOptions,
    locked: Boolean(locked),
  };
}
