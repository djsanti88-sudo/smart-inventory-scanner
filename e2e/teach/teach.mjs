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

function parseArgs(argv) {
  const args = { selfCheck: false, target: null, runId: null };
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
    }
  }
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

async function runSelfCheck({ target, runId, knowledge, manifest, curriculumModules }) {
  const { readKnowledge } = knowledge;
  const { createManifest, setStatus } = manifest;

  const k = await readKnowledge();
  const runNumber = computeRunNumber(k.runHistory);
  const mastered = masteredFrom(k.runHistory);
  const allLessons = await loadLessons();

  if (allLessons.length !== 11) {
    throw new Error(`SELF-CHECK FAILED: expected 11 lessons, found ${allLessons.length}`);
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
  console.log(`Total lessons discovered: ${allLessons.length} (expected 11)`);
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
    // Phase 1: launch tiled browsers, probe deployment mode, sign up each persona.
    const personaSetups = await Promise.all(
      PERSONAS.map(async (persona, i) => {
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
        return { persona, page, mode, businessId };
      })
    );

    if (browsers[0]) {
      try {
        browserVersion = browsers[0].version();
      } catch {
        browserVersion = 'chromium';
      }
    }

    const allBusinessIds = personaSetups.map((s) => s.businessId).filter(Boolean);
    const modes = new Set(personaSetups.map((s) => s.mode));
    const deploymentMode = modes.size === 1 ? [...modes][0] : 'mixed';

    // Phase 2: run the curriculum plan for each persona concurrently.
    const personaResults = await Promise.all(
      personaSetups.map(async ({ persona, page, mode, businessId }) => {
        const otherTenantIds = allBusinessIds.filter((id) => id !== businessId);
        const lessons = [];
        for (const lesson of plan) {
          if (limits.timeExceeded()) {
            lessons.push({
              id: lesson.id,
              title: lesson.title,
              level: lesson.level,
              pass: false,
              notes: 'skipped: run time budget exceeded before this lesson started',
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
          lessons.push({
            id: lesson.id,
            title: lesson.title,
            level: lesson.level,
            pass: Boolean(result.pass),
            notes: result.notes ?? null,
            findings,
            learned: result.learned ?? null,
          });
        }
        return { persona: persona.key, lessons };
      })
    );

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

  await runLive({ target, runId, knowledge, manifest, personas, report, limits });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
