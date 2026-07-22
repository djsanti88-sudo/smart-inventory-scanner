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
import * as ladder from './ladder.mjs';
import * as sheets from './sheets.mjs';
import * as triage from './triage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_TARGET = 'https://inventory-lovat-six.vercel.app';

const DEFAULT_LOOP_PERSONA = 'tire';

function parseArgs(argv) {
  const args = {
    selfCheck: false,
    target: null,
    runId: null,
    oneWindow: false,
    loop: false,
    persona: null,
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
    browser = await chromium.launch({ headless: false, args: ['--window-size=900,900'] });
    context = await newPersonaContext(browser, persona);
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

async function runLive({ target, runId, knowledge, manifest, personas, report, limits }) {
  const { readKnowledge, writeCoverage, appendRunHistory, appendDiscoveries, appendBugs, atomicWriteFile, PATHS } = knowledge;
  const { createManifest, setStatus, readManifest } = manifest;
  const { PERSONAS, probeDeployment, signUpPersona, newPersonaContext } = personas;
  const { writeReport } = report;

  const k = await readKnowledge();
  const runNumber = computeRunNumber(k.runHistory);
  const mastered = masteredFrom(k.runHistory);
  const allLessons = await loadLessons();
  const plan = buildPlan(allLessons, runNumber, mastered);

  await createManifest(runId, { target, personas: PERSONAS.map((p) => p.key) });
  const runDir = path.join(PATHS.artifactsDir, runId);

  limits.start();

  const browsers = [];
  const contexts = [];
  let browserVersion = 'chromium';
  let finalStatus = 'aborted';

  const startedAt = new Date().toISOString();
  let model = null;

  try {
    // Phase 1: launch tiled browsers, probe deployment mode, sign up each
    // persona. Each persona's setup is isolated in its own try/catch so ONE
    // persona failing (browser launch, probe, or signup) does not abort the
    // whole run - it is recorded as a setup failure and excluded from Phase 2,
    // while personas that DID set up successfully still run their lessons.
    const personaSetups = await Promise.all(
      PERSONAS.map(async (persona, i) => {
        try {
          const browser = await chromium.launch({
            headless: false,
            args: [`--window-position=${i * 650},0`, '--window-size=640,820'],
          });
          browsers.push(browser);
          const context = await newPersonaContext(browser, persona);
          contexts.push(context);
          const page = await context.newPage();
          const probe = await probeDeployment(page, target);
          const mode = probe.mode;
          let businessId = null;
          if (mode === 'live_auth') {
            const signup = await signUpPersona(page, { persona, runId, baseURL: target });
            businessId = signup.businessId;
          }
          return { persona, page, mode, businessId, setupFailed: false };
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
      })
    );

    if (browsers[0]) {
      try {
        browserVersion = browsers[0].version();
      } catch {
        browserVersion = 'chromium';
      }
    }

    const successfulSetups = personaSetups.filter((s) => !s.setupFailed);
    const failedSetups = personaSetups.filter((s) => s.setupFailed);

    const allBusinessIds = successfulSetups.map((s) => s.businessId).filter(Boolean);
    const modes = new Set(successfulSetups.map((s) => s.mode));
    const deploymentMode = modes.size === 1 ? [...modes][0] : (modes.size === 0 ? 'unknown' : 'mixed');

    // Setup-failed personas never enter the lessons phase; their failure is
    // still surfaced as a finding via a synthetic Phase-1 "lesson" entry so it
    // flows into the report the same way any other finding does.
    const failedPersonaResults = failedSetups.map(({ persona, setupFinding }) => ({
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
    }));

    // Phase 2: run the curriculum plan for each successfully set-up persona.
    const livePersonaResults = await Promise.all(
      successfulSetups.map(async ({ persona, page, mode, businessId }) => {
        const otherTenantIds = allBusinessIds.filter((id) => id !== businessId);
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
      })
    );

    const personaResults = [...failedPersonaResults, ...livePersonaResults];

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
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  }

  return finalStatus;
}

export async function main(argv) {
  const args = parseArgs(argv);
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
