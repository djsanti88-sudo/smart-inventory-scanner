#!/usr/bin/env node
// e2e/teach/teach.mjs
//
// Teach Bot ORCHESTRATOR: wires curriculum, personas, limits, lessons,
// triage, and knowledge persistence into one run against a real deployed
// Scanbin URL (or a self-check dry run with zero network / zero browser).
//
// Module-loading note: knowledge.mjs, manifest.mjs, personas.mjs, and
// report.mjs each resolve their file paths from process.env.TEACH_KNOWLEDGE_BASE
// at MODULE LOAD time (not call time). To let --self-check redirect all of
// them at a temp directory without ever touching the real testing/app-knowledge
// files, this file deliberately does NOT statically import any of those four
// modules - it dynamically imports them from inside main(), after deciding
// (and, for self-check, setting) TEACH_KNOWLEDGE_BASE. Every other sibling
// module here (curriculum, limits, ladder, sheets, triage, lessonHelpers) is
// path-independent and is imported statically as usual.

import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { chromium } from 'playwright';

import { computeRunNumber, masteredFrom, selectLessons, pickExploration, loadLessons } from './curriculum.mjs';
import { RunLimits } from './limits.mjs';
import * as h from './lessonHelpers.mjs';

// Headed-run pacing: slow each Playwright action so a human can watch (still far faster than a
// person). ~half speed by default; override with TEACH_SLOWMO_MS (0 = full speed).
const SLOWMO_MS = Number.isFinite(Number(process.env.TEACH_SLOWMO_MS)) ? Number(process.env.TEACH_SLOWMO_MS) : 600;
import * as ladder from './ladder.mjs';
import * as sheets from './sheets.mjs';
import * as triage from './triage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_TARGET = 'https://inventory-lovat-six.vercel.app';

const DEFAULT_LOOP_PERSONA = 'tire';

// Owner requirement: never show more than 2 headed windows at once. If more
// personas are queued than this, runLive() runs them in sequential batches
// of at most this many, split-screen left/right (see personas.mjs
// computeSplitLayout), rather than tiling all of them concurrently.
export const MAX_CONCURRENT_WINDOWS = 2;

/**
 * Pure batching helper: splits an ordered list into chunks of at most
 * `maxConcurrent` items each, preserving order. Used to cap how many headed
 * Playwright windows are open at the same time.
 */
export function batchPersonas(list, maxConcurrent = MAX_CONCURRENT_WINDOWS) {
  const batches = [];
  for (let i = 0; i < list.length; i += maxConcurrent) {
    batches.push(list.slice(i, i + maxConcurrent));
  }
  return batches;
}

export const USAGE = `Teach Bot - live-app learning Playwright harness

Usage: node e2e/teach/teach.mjs [flags]

Flags:
  --self-check           Zero-network, zero-browser dry run: loads the lesson
                          curriculum and prints the plan without touching the
                          real deployment, knowledge base, or creating accounts.
  --loop                 Run continuously (Ctrl-C to stop), reusing one signed-in
                          browser/account across rounds. Implies --one-window.
  --one-window           Single headed browser / single persona instead of the
                          default multi-window tiled run.
  --persona <key>        Persona to use with --one-window / --loop
                          (default: "${DEFAULT_LOOP_PERSONA}"; available keys are
                          defined in personas.mjs, e.g. tire, cstore, supp).
  --target <url>         Override the deployment URL (default: $TEACH_TARGET_URL
                          or ${DEFAULT_TARGET}).
  --run-id <id>          Override the generated run id.
  --help, -h             Print this usage and exit. Never launches a browser or
                          creates accounts.

Environment variables (run budget / behavior):
  TEACH_TARGET_URL         Default deployment URL (overridden by --target).
  TEACH_KNOWLEDGE_BASE     Redirects the knowledge-base file paths (used by
                            --self-check internally; do not point this at the
                            real testing/app-knowledge directory in normal runs).
  TEACH_SLOWMO_MS           Playwright slowMo in ms for headed runs (default 600).
  TEACH_MAX_PAID_LOOKUPS    Cap on paid decode lookups per run/loop.
  TEACH_MAX_REQUESTS        Cap on total lesson requests per run/loop.
  TEACH_MAX_MINUTES         Cap on wall-clock minutes per run/loop.
  TEACH_ESTIMATED_MAX_USD   Cap on estimated spend (USD) per run/loop.

Running with no flags launches the DEFAULT FULL LIVE RUN: 3 headed browsers,
one real account per persona, against the deployment above. Use --self-check
or --help first if you are unsure.`;

const KNOWN_VALUE_FLAGS = new Set(['--target', '--run-id', '--persona']);
const KNOWN_BOOLEAN_FLAGS = new Set(['--self-check', '--one-window', '--loop', '--help', '-h']);

export function parseArgs(argv) {
  const args = {
    selfCheck: false,
    target: null,
    runId: null,
    oneWindow: false,
    loop: false,
    persona: null,
    help: false,
    unknownFlag: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-check') {
      args.selfCheck = true;
    } else if (arg === '--target') {
      args.target = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--run-id') {
      args.runId = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--one-window') {
      args.oneWindow = true;
    } else if (arg === '--loop') {
      args.loop = true;
    } else if (arg === '--persona') {
      args.persona = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (typeof arg === 'string' && arg.startsWith('-') && !KNOWN_VALUE_FLAGS.has(arg) && !KNOWN_BOOLEAN_FLAGS.has(arg)) {
      args.unknownFlag = arg;
      break;
    }
  }
  // --loop always drives a single headed browser/persona (session persists across
  // rounds); there is no 3-up loop mode in this harness, so --loop implies
  // --one-window regardless of whether --one-window was also passed explicitly.
  if (args.loop) args.oneWindow = true;
  return args;
}

function generateRunId() {
  return `r${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
}

function gitShaShort() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

async function packageVersion() {
  try {
    const raw = await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function buildPlan(allLessons, runNumber, mastered) {
  const selected = selectLessons(allLessons, { runNumber });
  const explore = pickExploration(allLessons, { runNumber, mastered });
  const merged = [...selected];
  if (explore && !merged.some((l) => l.id === explore.id)) merged.push(explore);
  const seen = new Set();
  const deduped = [];
  for (const lesson of merged) {
    if (seen.has(lesson.id)) continue;
    seen.add(lesson.id);
    deduped.push(lesson);
  }
  return deduped.sort((a, b) => (a.level - b.level) || String(a.id).localeCompare(String(b.id)));
}

/** Extract the leading integer from a COVERAGE_MATRIX lesson key like "10-reconcile-equal-and-different". */
function leadingLevel(key) {
  const match = /^(\d+)-/.exec(key);
  return match ? Number(match[1]) : null;
}

function computeCoverageDelta(coverage, planLevels) {
  const lessons = coverage?.lessons && typeof coverage.lessons === 'object' ? coverage.lessons : {};
  const newlyCovered = [];
  const stillUncovered = [];
  for (const [key, entry] of Object.entries(lessons)) {
    const level = leadingLevel(key);
    const ran = level !== null && planLevels.has(level);
    const wasCovered = entry?.status === 'covered';
    if (ran && !wasCovered) newlyCovered.push(key);
    if (!ran && !wasCovered) stillUncovered.push(key);
  }
  return { newlyCovered, stillUncovered };
}

function updateCoverageForPlan(coverage, plan, runId) {
  const base = coverage && typeof coverage === 'object' ? coverage : { lessons: {} };
  const next = JSON.parse(JSON.stringify(base));
  next.lessons = next.lessons && typeof next.lessons === 'object' ? next.lessons : {};
  next.updatedAt = new Date().toISOString();
  const planLevels = new Map(plan.map((l) => [l.level, l]));
  for (const key of Object.keys(next.lessons)) {
    const level = leadingLevel(key);
    if (level !== null && planLevels.has(level)) {
      next.lessons[key] = { status: 'covered', lastRunId: runId };
    }
  }
  return next;
}

/**
 * Robustly resets the reused page to a clean, usable /scan state at the
 * start of every loop round. The reused page can drift off /scan between
 * rounds (a lesson leaves it on a different route, a client-side redirect
 * fires, etc.); without this reset, later rounds intermittently fail with
 * "scan input not visible" / "could not navigate to /scan" because the
 * round's lessons assume they're starting from /scan and they aren't.
 *
 * Returns { ready: true } once '#scanner-input' is confirmed visible, or
 * { ready: false, reason } if /scan genuinely cannot be reached (e.g. the
 * session was lost and the app bounced to /login) - the caller must stop
 * the loop gracefully in that case rather than spinning through doomed
 * rounds.
 */
async function ensureScanReady(page, target) {
  const scanUrl = `${target}/scan`;
  const gotoScan = async () => {
    try {
      await page.goto(scanUrl, { waitUntil: 'domcontentloaded' });
      return true;
    } catch {
      return false;
    }
  };

  let navigated = await gotoScan();
  if (!navigated) navigated = await gotoScan(); // retry once
  if (!navigated) {
    return { ready: false, reason: `could not navigate to ${scanUrl} after 2 attempts` };
  }

  const scannerVisible = async (timeout) =>
    page.locator('#scanner-input').isVisible({ timeout }).catch(() => false);

  if (await scannerVisible(15000)) {
    return { ready: true };
  }

  // Not on a usable /scan yet. Figure out why: session lost (bounced to
  // /login), or a business-context gate/banner needs re-selecting.
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }
  if (/\/login(\?|$)/.test(currentUrl)) {
    return { ready: false, reason: `session lost: bounced to ${currentUrl} instead of /scan` };
  }

  const bannerVisible = await page
    .getByTestId('business-context-banner')
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  const goToBusinessLink = page.getByTestId('go-to-business');
  const goToBusinessVisible = await goToBusinessLink.isVisible({ timeout: 2000 }).catch(() => false);

  if (bannerVisible || goToBusinessVisible) {
    try {
      if (goToBusinessVisible) {
        await goToBusinessLink.click();
      } else {
        await page.goto(`${target}/business`, { waitUntil: 'domcontentloaded' });
      }
      const selectButton = page.locator('[data-testid^="select-business-"]').first();
      await selectButton.waitFor({ state: 'visible', timeout: 15000 });
      await selectButton.click();
      await page.waitForURL('**/scan', { timeout: 30000 });
      if (await scannerVisible(15000)) {
        return { ready: true };
      }
      return { ready: false, reason: 're-selected business but #scanner-input never became visible on /scan' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ready: false, reason: `business re-selection failed: ${reason}` };
    }
  }

  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }
  if (/\/login(\?|$)/.test(currentUrl)) {
    return { ready: false, reason: `session lost: bounced to ${currentUrl} instead of /scan` };
  }

  return { ready: false, reason: `#scanner-input not visible on ${scanUrl} and no known gate (business banner/go-to-business) or login redirect detected (currentUrl=${currentUrl || 'unknown'})` };
}

/**
 * Runs one persona's curriculum plan against an already-signed-in page.
 * Extracted so both the default 3-browser runLive() and the one-window /
 * loop path (runOneWindow()) share the exact same lesson-execution
 * semantics (budget gates, prereq gates, crash handling) instead of two
 * copies drifting apart. `stopSignal`, when provided, is an object whose
 * `.requested` flag - set by a SIGINT handler - stops the round from
 * starting any further lesson (the lesson already in flight always finishes
 * first, since this is only checked between lessons, never mid-lesson).
 */
async function runLessonsForPersona({
  page,
  persona,
  runId,
  target,
  mode,
  plan,
  limits,
  runDir,
  otherTenantIds = [],
  stopSignal = null,
}) {
  const lessons = [];
  const passedLessonIds = new Set();
  for (const lesson of plan) {
    if (limits.timeExceeded() || limits.requestsExceeded()) {
      lessons.push({
        id: lesson.id,
        title: lesson.title,
        level: lesson.level,
        pass: false,
        notes: `skipped: run budget exceeded before this lesson started (${limits.reason()})`,
        findings: [],
        learned: null,
      });
      continue;
    }

    if (stopSignal?.requested) {
      lessons.push({
        id: lesson.id,
        title: lesson.title,
        level: lesson.level,
        pass: false,
        notes: 'skipped: stop requested (SIGINT) - finishing after the previously running lesson',
        findings: [],
        learned: null,
      });
      continue;
    }

    const missingPrereq = Array.isArray(lesson.prereqs)
      ? lesson.prereqs.find((id) => !passedLessonIds.has(id))
      : null;
    if (missingPrereq) {
      lessons.push({
        id: lesson.id,
        title: lesson.title,
        level: lesson.level,
        pass: true,
        notes: `skipped: prereq ${missingPrereq} not satisfied`,
        findings: [],
        learned: null,
      });
      continue;
    }

    const collected = [];
    let result;
    try {
      result = await lesson.run({
        page,
        persona,
        runId,
        baseURL: target,
        deploymentMode: mode,
        limits,
        h,
        ladder,
        sheets,
        triage,
        artifactsDir: runDir,
        recordFinding: (f) => collected.push(f),
        otherTenantIds,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const crashFinding = triage.buildFinding({
        title: `Lesson "${lesson.id}" threw an uncaught error`,
        category: 'crash',
        severity: 'high',
        lesson: lesson.id,
        persona: persona.key,
        repro: `Run lesson "${lesson.id}" for persona "${persona.key}" against ${target}`,
        expected: 'The lesson completes and returns a result without throwing.',
        actual: reason,
        triageClass: 'probable_app_bug',
      });
      result = { pass: false, findings: [crashFinding], learned: null, notes: `threw: ${reason}` };
    }

    const findings = [...collected, ...(Array.isArray(result.findings) ? result.findings : [])];

    if (findings.length > 0) {
      // Capture the page as it looked right after the lesson finished, so the
      // PDF report can show each bug's real state, not just its text. A
      // screenshot failure here must never break the run - it's proof, not
      // a requirement.
      try {
        const shotPath = path.join(runDir, `${lesson.id}-finding.png`);
        await h.screenshot(page, shotPath);
        for (const finding of findings) {
          if (finding && typeof finding === 'object') {
            finding.evidence = finding.evidence && typeof finding.evidence === 'object' ? finding.evidence : {};
            if (!finding.evidence.screenshot) finding.evidence.screenshot = shotPath;
          }
        }
      } catch {
        // best-effort; findings still get reported without a screenshot.
      }
    }

    const passed = Boolean(result.pass);
    if (passed) passedLessonIds.add(lesson.id);
    lessons.push({
      id: lesson.id,
      title: lesson.title,
      level: lesson.level,
      pass: passed,
      notes: result.notes ?? null,
      findings,
      learned: result.learned ?? null,
    });
  }
  return { persona: persona.key, lessons };
}

/** Builds the same run-model shape runLive() writes into report.md/.json, for one round. */
async function buildRunModel({
  runId,
  startedAt,
  target,
  browserVersion,
  deploymentMode,
  runNumber,
  personaResults,
  limits,
  manifest,
  k,
  plan,
}) {
  const manifestNow = await manifest.readManifest(runId);
  const finishedAt = new Date().toISOString();
  const planLevels = new Set(plan.map((l) => l.level));
  const coverageDelta = computeCoverageDelta(k.coverage, planLevels);
  const findings = personaResults.flatMap((pr) => pr.lessons.flatMap((l) => l.findings ?? []));
  const ladderRows = personaResults.flatMap((pr) =>
    pr.lessons.flatMap((l) => (Array.isArray(l.learned?.ladderRows) ? l.learned.ladderRows : []))
  );
  return {
    runId,
    startedAt,
    finishedAt,
    deployment: {
      url: target,
      gitSha: gitShaShort(),
      teachBotVersion: await packageVersion(),
      browserVersion,
      timestamp: finishedAt,
    },
    runNumber,
    deploymentMode,
    personaResults,
    findings,
    ladderRows,
    limits: {
      snapshot: limits.snapshot(),
      spendLine: limits.spendLine(),
      estimate: limits.estimateSpend(),
    },
    createdData: manifestNow.created ?? { accounts: [], businesses: [], docs: [] },
    coverageDelta,
  };
}

/**
 * The same end-of-round atomic knowledge write runLive() does (run history,
 * coverage, bugs, discoveries, candidate promotion, report). Reused by the
 * one-window / loop path so every round's write is byte-for-byte the same
 * shape as a normal run's.
 */
async function persistRunArtifacts({ knowledge, report, runId, model, plan, k }) {
  const { writeCoverage, appendRunHistory, appendDiscoveries, appendBugs, atomicWriteFile } = knowledge;
  const { writeReport } = report;
  const { finishedAt, findings } = model;

  await appendRunHistory({
    runId,
    at: finishedAt,
    runNumber: model.runNumber,
    deploymentMode: model.deploymentMode,
    results: model.personaResults.flatMap((pr) => pr.lessons.map((l) => ({ id: l.id, pass: l.pass }))),
    spend: model.limits.estimate,
    findingsCount: findings.length,
  });

  const nextCoverage = updateCoverageForPlan(k.coverage, plan, runId);
  await writeCoverage(nextCoverage);

  const confirmedBugs = findings.filter((f) => f?.triageClass === 'confirmed_app_bug');
  if (confirmedBugs.length > 0) {
    const md = confirmedBugs
      .map(
        (f) =>
          `## ${f.title}\n- run: ${runId}\n- severity: ${f.severity}\n- persona: ${f.persona}\n- lesson: ${f.lesson}\n- expected: ${f.expected}\n- actual: ${f.actual}`
      )
      .join('\n\n');
    await appendBugs(`\n<!-- run ${runId} -->\n${md}`);
  }

  const learnedNotes = model.personaResults
    .flatMap((pr) => pr.lessons.map((l) => ({ persona: pr.persona, id: l.id, learned: l.learned })))
    .filter((entry) => entry.learned && Object.keys(entry.learned).length > 0);
  if (learnedNotes.length > 0) {
    const md = learnedNotes
      .map((e) => `- [${runId}] ${e.persona}/${e.id}: ${JSON.stringify(e.learned)}`)
      .join('\n');
    await appendDiscoveries(`\n<!-- run ${runId} -->\n${md}`);
  }

  const stableCandidates = plan.filter((lesson) =>
    model.personaResults.every((pr) => pr.lessons.find((l) => l.id === lesson.id)?.pass === true)
  );
  const candidatesMd = [
    `# Suggested permanent-test candidates - run ${runId}`,
    '',
    'These lessons passed for every persona this run. They are candidates for',
    'promotion to a permanent Playwright test under testing/permanent - NOT',
    'auto-promoted. Owner review required before promotion.',
    '',
    stableCandidates.length > 0
      ? stableCandidates.map((l) => `- [level ${l.level}] ${l.id} (${l.title})`).join('\n')
      : '(no candidates this run)',
  ].join('\n');
  await atomicWriteFile(
    path.join(REPO_ROOT, 'testing', 'tests', 'candidates', `${runId}-suggested.md`),
    `${candidatesMd}\n`
  );

  return writeReport(runId, model);
}

/**
 * One-window mode: a single headed browser, single persona, instead of the
 * default 3 tiled browsers. With `loop: true`, rounds run continuously
 * (Ctrl-C / SIGINT to stop) reusing the SAME signed-in browser context/page
 * across every round - the persona account is created once (round 1) and
 * reused thereafter, never re-created. Each round recomputes runNumber from
 * the (growing) RUN_HISTORY so the curriculum deepens round over round, then
 * does the same atomic end-of-round knowledge write a normal run does. A
 * single RunLimits instance (created by the caller, started once here) caps
 * PAID decode spend across the WHOLE loop, not per round - an unattended
 * loop must never run unbounded paid spend. Free/UI lessons are unaffected:
 * `limits.canPaidLookup()` (checked inside individual lessons) is the only
 * gate on paid rungs; it never blocks free lessons.
 */
async function runOneWindow({ target, runId, knowledge, manifest, personas, report, limits, personaKey, loop }) {
  const { readKnowledge, PATHS } = knowledge;
  const { createManifest, setStatus } = manifest;
  const { PERSONAS, probeDeployment, signUpPersona, newPersonaContext } = personas;
  const { writeLoopReport } = report;

  const persona = PERSONAS.find((p) => p.key === personaKey);
  if (!persona) {
    throw new Error(
      `--persona "${personaKey}" is not a known persona (available: ${PERSONAS.map((p) => p.key).join(', ')})`
    );
  }

  const loopId = `loop-${runId}`;
  limits.start();

  const stopSignal = { requested: false };
  const onSigint = () => {
    if (stopSignal.requested) return;
    stopSignal.requested = true;
    console.log('\nSIGINT received: finishing the current lesson, then stopping gracefully...');
  };
  process.on('SIGINT', onSigint);

  const cumulativeFindingsByKey = new Map();
  const coveredLessons = new Set();
  let roundsCompleted = 0;
  let reused = { email: null, businessId: null, personaKey: persona.key };
  let finalStatus = 'aborted';
  let lastRoundRunId = null;
  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({ headless: false, slowMo: SLOWMO_MS, args: ['--window-size=900,900'] });
    context = await newPersonaContext(browser, persona);
    await h.installCursor(context);
    const page = await context.newPage();

    // The round-1 manifest must exist BEFORE signup, because signUpPersona records the created
    // account/business into it. (Rounds > 1 create their own manifest inside the loop.)
    await createManifest(runId, { target, personas: [persona.key] });

    const probe = await probeDeployment(page, target);
    const mode = probe.mode;
    if (mode === 'live_auth') {
      const signup = await signUpPersona(page, { persona, runId, baseURL: target });
      reused = { email: signup.email, businessId: signup.businessId, personaKey: persona.key };
    }

    let browserVersion = 'chromium';
    try {
      browserVersion = browser.version();
    } catch {
      browserVersion = 'chromium';
    }

    for (;;) {
      const roundNumber = roundsCompleted + 1;
      const roundRunId = roundNumber === 1 ? runId : generateRunId();
      lastRoundRunId = roundRunId;
      const startedAt = new Date().toISOString();

      const k = await readKnowledge();
      const runNumber = computeRunNumber(k.runHistory);
      const mastered = masteredFrom(k.runHistory);
      const allLessons = await loadLessons();
      const plan = buildPlan(allLessons, runNumber, mastered);

      if (roundNumber > 1) {
        // Round 1's manifest was already created before signup (and holds the recorded account).
        await createManifest(roundRunId, { target, personas: [persona.key] });
      }
      const runDir = path.join(PATHS.artifactsDir, roundRunId);

      // Round 1 lands on /scan via signUpPersona already, so skip the reset there
      // and only guard against between-rounds drift from round 2 onward.
      if (roundNumber > 1) {
        const resetResult = await ensureScanReady(page, target);
        if (!resetResult.ready) {
          console.log(`Round ${roundNumber}: could not reach a usable /scan (${resetResult.reason}). Stopping loop gracefully.`);
          const envFinding = triage.buildFinding({
            title: 'Loop round could not reach a usable /scan state',
            category: 'harness',
            severity: 'high',
            lesson: 'round-reset',
            persona: persona.key,
            repro: `Loop round ${roundNumber}: navigate the reused page to ${target}/scan and confirm #scanner-input is visible (re-selecting the business on a context-gate banner if shown).`,
            expected: '#scanner-input becomes visible on /scan, either directly or after re-selecting the reused business.',
            actual: resetResult.reason,
            triageClass: 'environment_problem',
          });
          const abortedPersonaResults = [
            {
              persona: persona.key,
              lessons: [
                {
                  id: 'round-reset',
                  title: 'Between-rounds /scan reset',
                  level: 0,
                  pass: false,
                  notes: 'loop stopped: could not reach a usable /scan state',
                  findings: [envFinding],
                  learned: null,
                },
              ],
            },
          ];
          const abortedModel = await buildRunModel({
            runId: roundRunId,
            startedAt,
            target,
            browserVersion,
            deploymentMode: mode,
            runNumber,
            personaResults: abortedPersonaResults,
            limits,
            manifest,
            k,
            plan,
          });
          await persistRunArtifacts({ knowledge, report, runId: roundRunId, model: abortedModel, plan, k });
          await setStatus(roundRunId, 'aborted');
          lastRoundRunId = roundRunId;
          finalStatus = 'aborted';
          break;
        }
      }

      const personaResult = await runLessonsForPersona({
        page,
        persona,
        runId: roundRunId,
        target,
        mode,
        plan,
        limits,
        runDir,
        otherTenantIds: [],
        stopSignal,
      });
      const personaResults = [personaResult];

      const model = await buildRunModel({
        runId: roundRunId,
        startedAt,
        target,
        browserVersion,
        deploymentMode: mode,
        runNumber,
        personaResults,
        limits,
        manifest,
        k,
        plan,
      });

      const { mdPath: reportPath } = await persistRunArtifacts({ knowledge, report, runId: roundRunId, model, plan, k });
      await setStatus(roundRunId, 'completed');
      roundsCompleted = roundNumber;
      finalStatus = 'completed';
      console.log(`Round ${roundNumber} done (${roundRunId}). Report: ${reportPath}`);
      console.log(limits.spendLine());

      const newFindings = [];
      for (const f of model.findings) {
        const key = `${f?.lesson ?? '?'}::${f?.title ?? '?'}`;
        if (!cumulativeFindingsByKey.has(key)) {
          cumulativeFindingsByKey.set(key, f);
          newFindings.push(f);
        }
      }
      const newlyCoveredThisRound = [];
      for (const id of model.coverageDelta.newlyCovered) {
        if (!coveredLessons.has(id)) {
          coveredLessons.add(id);
          newlyCoveredThisRound.push(id);
        }
      }
      const stillLearning = newFindings.length > 0 || newlyCoveredThisRound.length > 0;

      const loopModel = {
        loopId,
        target,
        roundsCompleted,
        currentRunNumber: runNumber,
        reused,
        lastRoundId: roundRunId,
        stillLearning,
        cumulativeFindings: [...cumulativeFindingsByKey.values()],
        coveredLessons: [...coveredLessons].sort(),
        spendLine: limits.spendLine(),
      };
      const { mdPath: loopReportPath } = await writeLoopReport(loopId, loopModel);
      console.log(`LOOP report: ${loopReportPath}`);

      if (!loop || stopSignal.requested) break;

      try {
        await page.goto(`${target}/scan`, { waitUntil: 'domcontentloaded' });
      } catch {
        // best-effort; the next round's lessons still navigate as needed.
      }
    }
  } catch (err) {
    finalStatus = 'aborted';
    if (lastRoundRunId) {
      try {
        await setStatus(lastRoundRunId, 'aborted');
      } catch {
        // best-effort
      }
    }
    throw err;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  if (stopSignal.requested) {
    // A SIGINT was handled gracefully above (reports written, status
    // completed, browser closed) - exit cleanly rather than relying on
    // Node's default post-SIGINT behavior, which we overrode by registering
    // a listener.
    process.exit(0);
  }

  return finalStatus;
}

async function runSelfCheck({ target, runId, knowledge, manifest, curriculumModules }) {
  const { readKnowledge } = knowledge;
  const { createManifest, setStatus } = manifest;

  const k = await readKnowledge();
  const runNumber = computeRunNumber(k.runHistory);
  const mastered = masteredFrom(k.runHistory);
  const allLessons = await loadLessons();

  const MIN_LESSONS = 11;
  if (allLessons.length < MIN_LESSONS) {
    throw new Error(`SELF-CHECK FAILED: expected at least ${MIN_LESSONS} lessons, found ${allLessons.length}`);
  }

  const plan = buildPlan(allLessons, runNumber, mastered);

  const deployment = {
    url: target,
    gitSha: gitShaShort(),
    teachBotVersion: await packageVersion(),
    browserVersion: 'chromium (not launched in self-check)',
    timestamp: new Date().toISOString(),
  };

  await createManifest(runId, { target, personas: curriculumModules.PERSONAS.map((p) => p.key) });
  const readBack = await manifest.readManifest(runId);

  console.log('=== Teach Bot self-check ===');
  console.log('Deployment stamp:', JSON.stringify(deployment, null, 2));
  console.log(`Run number: ${runNumber}`);
  console.log(`Total lessons discovered: ${allLessons.length} (>= ${MIN_LESSONS} expected)`);
  console.log('Ordered plan:');
  for (const lesson of plan) {
    console.log(`  - [level ${lesson.level}] ${lesson.id} (${lesson.title})`);
  }
  console.log(`Would create ${curriculumModules.PERSONAS.length} accounts (one per persona): ${curriculumModules.PERSONAS.map((p) => p.key).join(', ')}`);
  console.log(`Manifest round-trip OK: status=${readBack.status}, runId=${readBack.runId}`);

  await setStatus(runId, 'completed');
  console.log('SELF-CHECK OK');
}

// Assumed screen size for the split-screen window layout, overridable for
// unusual monitor setups. Only affects where headed windows are placed -
// never affects headless/self-check paths.
const SCREEN_WIDTH = Number.isFinite(Number(process.env.TEACH_SCREEN_WIDTH)) ? Number(process.env.TEACH_SCREEN_WIDTH) : 1920;
const SCREEN_HEIGHT = Number.isFinite(Number(process.env.TEACH_SCREEN_HEIGHT)) ? Number(process.env.TEACH_SCREEN_HEIGHT) : 1080;

/**
 * Runs Phase 1 (launch + probe + signup) for one persona at the given
 * split-screen slot index (0 = left half, 1 = right half). Isolated in its
 * own try/catch so one persona failing does not abort its batch - it is
 * recorded as a setup failure and excluded from Phase 2.
 */
async function setupPersonaWindow({ persona, slotIndex, target, runId, personasModule }) {
  const { probeDeployment, signUpPersona, newPersonaContext } = personasModule;
  const layout = personasModule.computeSplitLayout(SCREEN_WIDTH, SCREEN_HEIGHT, slotIndex);
  try {
    const browser = await chromium.launch({
      headless: false,
      slowMo: SLOWMO_MS,
      args: [`--window-position=${layout.x},${layout.y}`, `--window-size=${layout.width},${layout.height}`],
    });
    const context = await newPersonaContext(browser, persona);
    await h.installCursor(context);
    const page = await context.newPage();
    const probe = await probeDeployment(page, target);
    const mode = probe.mode;
    let businessId = null;
    if (mode === 'live_auth') {
      const signup = await signUpPersona(page, { persona, runId, baseURL: target });
      businessId = signup.businessId;
    }
    return { persona, browser, context, page, mode, businessId, setupFailed: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const setupFinding = triage.buildFinding({
      title: `Persona "${persona.key}" failed Phase-1 setup`,
      category: 'harness',
      severity: 'high',
      lesson: 'phase1-setup',
      persona: persona.key,
      repro: `Launch browser, probe deployment, and sign up persona "${persona.key}" against ${target}`,
      expected: 'The persona launches a browser, probes the deployment, and (if live_auth) signs up successfully.',
      actual: reason,
      triageClass: 'environment_problem',
    });
    return { persona, setupFailed: true, setupFinding };
  }
}

/** Runs the curriculum plan for one already-set-up persona (Phase 2). */
async function runPlanForPersona({ persona, page, mode, businessId, otherTenantIds, runId, target, plan, limits, runDir }) {
  const lessons = [];
  const passedLessonIds = new Set();
  for (const lesson of plan) {
    if (limits.timeExceeded() || limits.requestsExceeded()) {
      lessons.push({
        id: lesson.id,
        title: lesson.title,
        level: lesson.level,
        pass: false,
        notes: `skipped: run budget exceeded before this lesson started (${limits.reason()})`,
        findings: [],
        learned: null,
      });
      continue;
    }

    const missingPrereq = Array.isArray(lesson.prereqs)
      ? lesson.prereqs.find((id) => !passedLessonIds.has(id))
      : null;
    if (missingPrereq) {
      lessons.push({
        id: lesson.id,
        title: lesson.title,
        level: lesson.level,
        pass: true,
        notes: `skipped: prereq ${missingPrereq} not satisfied`,
        findings: [],
        learned: null,
      });
      continue;
    }

    const collected = [];
    let result;
    try {
      result = await lesson.run({
        page,
        persona,
        runId,
        baseURL: target,
        deploymentMode: mode,
        limits,
        h,
        ladder,
        sheets,
        triage,
        artifactsDir: runDir,
        recordFinding: (f) => collected.push(f),
        otherTenantIds,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const crashFinding = triage.buildFinding({
        title: `Lesson "${lesson.id}" threw an uncaught error`,
        category: 'crash',
        severity: 'high',
        lesson: lesson.id,
        persona: persona.key,
        repro: `Run lesson "${lesson.id}" for persona "${persona.key}" against ${target}`,
        expected: 'The lesson completes and returns a result without throwing.',
        actual: reason,
        triageClass: 'probable_app_bug',
      });
      result = { pass: false, findings: [crashFinding], learned: null, notes: `threw: ${reason}` };
    }

    const findings = [...collected, ...(Array.isArray(result.findings) ? result.findings : [])];
    const passed = Boolean(result.pass);
    if (passed) passedLessonIds.add(lesson.id);
    lessons.push({
      id: lesson.id,
      title: lesson.title,
      level: lesson.level,
      pass: passed,
      notes: result.notes ?? null,
      findings,
      learned: result.learned ?? null,
    });
  }
  return { persona: persona.key, lessons };
}

async function runLive({ target, runId, knowledge, manifest, personas, report, limits }) {
  const { readKnowledge, writeCoverage, appendRunHistory, appendDiscoveries, appendBugs, atomicWriteFile, PATHS } = knowledge;
  const { createManifest, setStatus, readManifest } = manifest;
  const { PERSONAS } = personas;
  const { writeReport } = report;

  const k = await readKnowledge();
  const runNumber = computeRunNumber(k.runHistory);
  const mastered = masteredFrom(k.runHistory);
  const allLessons = await loadLessons();
  const plan = buildPlan(allLessons, runNumber, mastered);

  await createManifest(runId, { target, personas: PERSONAS.map((p) => p.key) });
  const runDir = path.join(PATHS.artifactsDir, runId);

  limits.start();

  let browserVersion = 'chromium';
  let finalStatus = 'aborted';

  const startedAt = new Date().toISOString();
  let model = null;

  try {
    // Owner requirement: never show more than MAX_CONCURRENT_WINDOWS headed
    // windows at once. Personas run in sequential batches (default: pairs),
    // each batch split-screen left/right; every batch's browsers are fully
    // closed before the next batch launches, so at most MAX_CONCURRENT_WINDOWS
    // windows are ever visible concurrently, regardless of how many personas
    // are queued.
    const personaBatches = batchPersonas(PERSONAS, MAX_CONCURRENT_WINDOWS);
    const personaResults = [];
    const failedPersonaResults = [];
    const allBusinessIdsSoFar = [];
    const modesSeen = new Set();

    for (const batch of personaBatches) {
      // Phase 1 (this batch only): launch split-screen browsers, probe, sign up.
      const personaSetups = await Promise.all(
        batch.map((persona, slotIndex) =>
          setupPersonaWindow({ persona, slotIndex, target, runId, personasModule: personas })
        )
      );

      const browsers = personaSetups.map((s) => s.browser).filter(Boolean);
      const contexts = personaSetups.map((s) => s.context).filter(Boolean);

      if (browserVersion === 'chromium' && browsers[0]) {
        try {
          browserVersion = browsers[0].version();
        } catch {
          browserVersion = 'chromium';
        }
      }

      const successfulSetups = personaSetups.filter((s) => !s.setupFailed);
      const failedSetups = personaSetups.filter((s) => s.setupFailed);

      for (const s of successfulSetups) {
        if (s.businessId) allBusinessIdsSoFar.push(s.businessId);
        if (s.mode) modesSeen.add(s.mode);
      }

      // Setup-failed personas never enter the lessons phase; their failure is
      // still surfaced as a finding via a synthetic Phase-1 "lesson" entry so
      // it flows into the report the same way any other finding does.
      for (const { persona, setupFinding } of failedSetups) {
        failedPersonaResults.push({
          persona: persona.key,
          lessons: [
            {
              id: 'phase1-setup',
              title: 'Phase 1 persona setup',
              level: 0,
              pass: false,
              notes: 'setup failed: excluded from lessons phase',
              findings: [setupFinding],
              learned: null,
            },
          ],
        });
      }

      try {
        // Phase 2 (this batch only): run the curriculum plan for each
        // successfully set-up persona in the batch.
        const batchResults = await Promise.all(
          successfulSetups.map(({ persona, page, mode, businessId }) =>
            runPlanForPersona({
              persona,
              page,
              mode,
              businessId,
              otherTenantIds: allBusinessIdsSoFar.filter((id) => id !== businessId),
              runId,
              target,
              plan,
              limits,
              runDir,
            })
          )
        );
        personaResults.push(...batchResults);
      } finally {
        // Close this batch's windows before the next batch opens, so no more
        // than MAX_CONCURRENT_WINDOWS are ever visible at once.
        await Promise.all(contexts.map((c) => c.close().catch(() => {})));
        await Promise.all(browsers.map((b) => b.close().catch(() => {})));
      }
    }

    personaResults.unshift(...failedPersonaResults);

    const deploymentMode = modesSeen.size === 1 ? [...modesSeen][0] : (modesSeen.size === 0 ? 'unknown' : 'mixed');

    const findings = personaResults.flatMap((pr) => pr.lessons.flatMap((l) => l.findings ?? []));
    const ladderRows = personaResults.flatMap((pr) =>
      pr.lessons.flatMap((l) => (Array.isArray(l.learned?.ladderRows) ? l.learned.ladderRows : []))
    );

    const manifestNow = await readManifest(runId);
    const finishedAt = new Date().toISOString();
    const planLevels = new Set(plan.map((l) => l.level));
    const coverageDelta = computeCoverageDelta(k.coverage, planLevels);

    model = {
      runId,
      startedAt,
      finishedAt,
      deployment: {
        url: target,
        gitSha: gitShaShort(),
        teachBotVersion: await packageVersion(),
        browserVersion,
        timestamp: finishedAt,
      },
      runNumber,
      deploymentMode,
      personaResults,
      findings,
      ladderRows,
      limits: {
        snapshot: limits.snapshot(),
        spendLine: limits.spendLine(),
        estimate: limits.estimateSpend(),
      },
      createdData: manifestNow.created ?? { accounts: [], businesses: [], docs: [] },
      coverageDelta,
    };

    // Single atomic knowledge write at the end - the orchestrator is the only writer.
    const findingsCount = findings.length;
    await appendRunHistory({
      runId,
      at: finishedAt,
      runNumber,
      deploymentMode,
      results: personaResults.flatMap((pr) => pr.lessons.map((l) => ({ id: l.id, pass: l.pass }))),
      spend: limits.estimateSpend(),
      findingsCount,
    });

    const nextCoverage = updateCoverageForPlan(k.coverage, plan, runId);
    await writeCoverage(nextCoverage);

    const confirmedBugs = findings.filter((f) => f?.triageClass === 'confirmed_app_bug');
    if (confirmedBugs.length > 0) {
      const md = confirmedBugs
        .map(
          (f) =>
            `## ${f.title}\n- run: ${runId}\n- severity: ${f.severity}\n- persona: ${f.persona}\n- lesson: ${f.lesson}\n- expected: ${f.expected}\n- actual: ${f.actual}`
        )
        .join('\n\n');
      await appendBugs(`\n<!-- run ${runId} -->\n${md}`);
    }

    const learnedNotes = personaResults
      .flatMap((pr) => pr.lessons.map((l) => ({ persona: pr.persona, id: l.id, learned: l.learned })))
      .filter((entry) => entry.learned && Object.keys(entry.learned).length > 0);
    if (learnedNotes.length > 0) {
      const md = learnedNotes
        .map((e) => `- [${runId}] ${e.persona}/${e.id}: ${JSON.stringify(e.learned)}`)
        .join('\n');
      await appendDiscoveries(`\n<!-- run ${runId} -->\n${md}`);
    }

    // Candidate promotion note - owner-approved promotion only, never auto-generated tests.
    const stableCandidates = plan.filter((lesson) =>
      personaResults.every((pr) => pr.lessons.find((l) => l.id === lesson.id)?.pass === true)
    );
    const candidatesMd = [
      `# Suggested permanent-test candidates - run ${runId}`,
      '',
      'These lessons passed for every persona this run. They are candidates for',
      'promotion to a permanent Playwright test under testing/permanent - NOT',
      'auto-promoted. Owner review required before promotion.',
      '',
      stableCandidates.length > 0
        ? stableCandidates.map((l) => `- [level ${l.level}] ${l.id} (${l.title})`).join('\n')
        : '(no candidates this run)',
    ].join('\n');
    await atomicWriteFile(
      path.join(REPO_ROOT, 'testing', 'tests', 'candidates', `${runId}-suggested.md`),
      `${candidatesMd}\n`
    );

    await writeReport(runId, model);
    await setStatus(runId, 'completed');
    finalStatus = 'completed';

    console.log(`Report written: ${path.join(runDir, 'report.md')}`);
    console.log(limits.spendLine());
  } catch (err) {
    finalStatus = 'aborted';
    try {
      await setStatus(runId, 'aborted');
    } catch {
      // best-effort
    }
    if (model) {
      try {
        await writeReport(runId, model);
      } catch {
        // best-effort
      }
    }
    throw err;
  }
  // No outer finally browser/context cleanup needed here: each batch's
  // windows are already closed inline (see the per-batch try/finally above)
  // before the next batch launches, keeping at most MAX_CONCURRENT_WINDOWS
  // windows open at any moment.

  return finalStatus;
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.unknownFlag) {
    console.error(`Unrecognized flag: ${args.unknownFlag}`);
    console.error('Run with --help to see the available flags.');
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const target = args.target ?? process.env.TEACH_TARGET_URL ?? DEFAULT_TARGET;
  const runId = args.runId ?? generateRunId();

  if (args.selfCheck) {
    let tempBase = null;
    const hadEnv = Boolean(process.env.TEACH_KNOWLEDGE_BASE);
    if (!hadEnv) {
      tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'teach-selfcheck-'));
      process.env.TEACH_KNOWLEDGE_BASE = tempBase;
    }
    try {
      const knowledge = await import('./knowledge.mjs');
      const manifest = await import('./manifest.mjs');
      const personas = await import('./personas.mjs');
      await runSelfCheck({ target, runId, knowledge, manifest, curriculumModules: personas });
    } finally {
      if (!hadEnv) {
        delete process.env.TEACH_KNOWLEDGE_BASE;
        if (tempBase) await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
      }
    }
    return;
  }

  const knowledge = await import('./knowledge.mjs');
  const manifest = await import('./manifest.mjs');
  const personas = await import('./personas.mjs');
  const report = await import('./report.mjs');
  const limits = new RunLimits({});

  if (args.oneWindow) {
    const personaKey = args.persona ?? DEFAULT_LOOP_PERSONA;
    await runOneWindow({ target, runId, knowledge, manifest, personas, report, limits, personaKey, loop: args.loop });
    return;
  }

  await runLive({ target, runId, knowledge, manifest, personas, report, limits });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
