// e2e/teach/report.mjs
//
// Teach Bot report writer: turns a run model into a human-readable Markdown
// report and a machine-readable JSON twin, and writes both into the run's
// artifacts directory. Never prints or persists secrets (passwords, tokens).
//
// Pure formatting lives in buildReportMarkdown/buildReportJson so they can be
// unit-tested without touching the filesystem; writeReport is the only I/O
// entry point and reuses knowledge.mjs's atomicWriteFile so report writes
// follow the same "never touch LOCKED_REQUIREMENTS.md" safety rule as every
// other knowledge-file write in this harness.

import path from 'node:path';
import { PATHS, atomicWriteFile } from './knowledge.mjs';

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function severityRank(sev) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, sev) ? SEVERITY_ORDER[sev] : 99;
}

function fmtList(items) {
  if (!Array.isArray(items) || items.length === 0) return '(none)';
  return items.map((i) => `- ${i}`).join('\n');
}

function evidenceLine(evidence) {
  if (!evidence || typeof evidence !== 'object') return '(none)';
  const parts = [];
  for (const key of ['screenshot', 'trace', 'video', 'consoleLog', 'networkLog']) {
    if (evidence[key]) parts.push(`${key}: ${evidence[key]}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(none)';
}

function deploymentTable(deployment = {}, runNumber, deploymentMode) {
  const rows = [
    ['URL', deployment.url ?? '(unknown)'],
    ['Build / git sha', deployment.gitSha ?? 'unknown'],
    ['Teach Bot version', deployment.teachBotVersion ?? 'unknown'],
    ['Browser', deployment.browserVersion ?? 'unknown'],
    ['Timestamp', deployment.timestamp ?? '(unknown)'],
    ['Run number', String(runNumber ?? '?')],
    ['Deployment mode', deploymentMode ?? '(unknown)'],
  ];
  const header = '| Field | Value |\n|---|---|';
  const body = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return `${header}\n${body}`;
}

function summarySection(model) {
  const allLessons = (model.personaResults ?? []).flatMap((pr) => pr.lessons ?? []);
  const total = allLessons.length;
  const passed = allLessons.filter((l) => l.pass === true).length;
  const findings = Array.isArray(model.findings) ? model.findings : [];
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (Object.prototype.hasOwnProperty.call(bySeverity, f?.severity)) bySeverity[f.severity] += 1;
  }
  const spendLine = model.limits?.spendLine ?? '(no spend data)';
  return [
    '## Summary',
    '',
    `Lessons passed: ${passed}/${total}`,
    `Findings by severity: critical ${bySeverity.critical}, high ${bySeverity.high}, medium ${bySeverity.medium}, low ${bySeverity.low}`,
    spendLine,
  ].join('\n');
}

function findingBlock(f) {
  const lines = [
    `### ${f.title ?? '(untitled finding)'}`,
    '',
    `- Severity: ${f.severity ?? '(unknown)'}`,
    `- Triage class: ${f.triageClass ?? '(unclassified)'}`,
    `- Locked requirement conflict: ${f.locked ? 'YES' : 'no'}`,
    `- Persona: ${f.persona ?? '(n/a)'}`,
    `- Lesson: ${f.lesson ?? '(n/a)'}`,
    `- Repro: ${f.repro ?? '(n/a)'}`,
    `- Expected: ${f.expected ?? '(n/a)'}`,
    `- Actual: ${f.actual ?? '(n/a)'}`,
    `- Customer impact: ${f.customerImpact ?? '(n/a)'}`,
    `- Evidence: ${evidenceLine(f.evidence)}`,
  ];
  const options = Array.isArray(f.options) ? f.options : [];
  if (options.length > 0) {
    lines.push('- Options:');
    for (const opt of options) lines.push(`  - ${typeof opt === 'string' ? opt : JSON.stringify(opt)}`);
  } else {
    lines.push('- Options: (needs solution options - none proposed)');
  }
  return lines.join('\n');
}

function bugsSection(findings) {
  const bugs = findings
    .filter((f) => f && f.category !== 'empty_field' && f.category !== 'performance' && f.category !== 'nice_to_have')
    .slice()
    .sort((a, b) => severityRank(a?.severity) - severityRank(b?.severity));
  if (bugs.length === 0) return '## Bugs\n\n(none found)';
  return ['## Bugs', '', bugs.map(findingBlock).join('\n\n')].join('\n');
}

function categorySection(title, findings, category) {
  const matches = findings.filter((f) => f && f.category === category);
  if (matches.length === 0) return `## ${title}\n\n(none found)`;
  return [`## ${title}`, '', matches.map(findingBlock).join('\n\n')].join('\n');
}

function ladderSection(ladderRows) {
  const rows = Array.isArray(ladderRows) ? ladderRows : [];
  if (rows.length === 0) return '## Ladder diagnosis\n\n(no ladder traces captured this run)';
  const header = '| code | settledRung | reachedGpt | gptSkipReason | partialIdentity | confidence |\n|---|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.code ?? '?'} | ${r.settledRung ?? 'none'} | ${r.reachedGpt ? 'yes' : 'no'} | ${r.gptSkipReason ?? '-'} | ${r.partialIdentity ? 'yes' : 'no'} | ${r.confidence ?? '-'} |`
    )
    .join('\n');
  return `## Ladder diagnosis\n\n${header}\n${body}`;
}

function createdDataSection(createdData) {
  const accounts = createdData?.accounts ?? [];
  const businesses = createdData?.businesses ?? [];
  const accountLines = accounts.map((a) => `- ${a.email ?? '(unknown email)'} (persona: ${a.personaKey ?? '?'})`);
  const businessLines = businesses.map((b) => `- ${b.id ?? '(unknown id)'} - ${b.label ?? '(unlabeled)'} (persona: ${b.personaKey ?? '?'})`);
  return [
    '## Created data (for Firebase console sweep)',
    '',
    'Accounts:',
    fmtList(accountLines),
    '',
    'Businesses:',
    fmtList(businessLines),
    '',
    'NOTE: passwords are never recorded anywhere; delete these test accounts/businesses via the Firebase console.',
  ].join('\n');
}

function coverageDeltaSection(coverageDelta) {
  const newly = coverageDelta?.newlyCovered ?? [];
  const still = coverageDelta?.stillUncovered ?? [];
  return [
    '## Coverage delta',
    '',
    'Newly covered:',
    fmtList(newly),
    '',
    'Still uncovered:',
    fmtList(still),
  ].join('\n');
}

function spendSection(model) {
  const line = model.limits?.spendLine ?? '(no spend data)';
  return ['## Spend', '', line, '', 'True spend = provider console.'].join('\n');
}

export function buildReportMarkdown(model) {
  const findings = Array.isArray(model.findings) ? model.findings : [];
  const title = `# Teach Bot Report - run ${model.runId ?? '(unknown)'}`;
  const sections = [
    title,
    '',
    deploymentTable(model.deployment, model.runNumber, model.deploymentMode),
    '',
    summarySection(model),
    '',
    bugsSection(findings),
    '',
    categorySection('Empty fields', findings, 'empty_field'),
    '',
    categorySection('Performance', findings, 'performance'),
    '',
    categorySection('Nice-to-haves', findings, 'nice_to_have'),
    '',
    ladderSection(model.ladderRows),
    '',
    createdDataSection(model.createdData),
    '',
    coverageDeltaSection(model.coverageDelta),
    '',
    spendSection(model),
  ];
  return `${sections.join('\n')}\n`;
}

export function buildReportJson(model) {
  return JSON.stringify(model, null, 2);
}

export async function writeReport(runId, model) {
  const runDir = path.join(PATHS.artifactsDir, runId);
  const mdPath = path.join(runDir, 'report.md');
  const jsonPath = path.join(runDir, 'report.json');
  await atomicWriteFile(mdPath, buildReportMarkdown(model));
  await atomicWriteFile(jsonPath, `${buildReportJson(model)}\n`);
  return { mdPath, jsonPath };
}
