#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATUSES = new Set(["PROVED", "BLOCKED", "UNKNOWN"]);

const SECRET_KEY_PATTERN = /(api[_-]?key|auth|bearer|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE_PATTERN = /(sk_(live|test|proj)_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|AIza[0-9A-Za-z_-]+|Authorization:\s*Bearer\s+\S+|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|[?&](?:api[_-]?key|token|secret|password|credential|auth)=[^&#\s]+|https?:\/\/[^/\s:@]+:[^@\s/]+@)/i;

const CONTROL_ORDER = [
  "turso.backups",
  "turso.pitr",
  "turso.replica",
  "turso.failover",
  "vercel.observability",
  "vercel.deploymentChecks",
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function baseControl(key, label, rawEvidence) {
  return {
    key,
    label,
    status: "UNKNOWN",
    reason: "",
    evidence: rawEvidence ?? null,
  };
}

function explicitEvidencePresent(item) {
  return item && typeof item === "object" && hasText(item.source) && hasText(item.observedAt);
}

function mark(control, status, reason) {
  if (!STATUSES.has(status)) {
    throw new Error(`Invalid readiness status: ${status}`);
  }
  return { ...control, status, reason };
}

function evaluateTursoBackups(evidence) {
  const item = evidence?.turso?.backups;
  const control = baseControl("turso.backups", "Turso backups", item);
  if (!item) return mark(control, "UNKNOWN", "No explicit backup evidence was supplied.");
  if (!explicitEvidencePresent(item)) return mark(control, "UNKNOWN", "Backup evidence must include non-secret source and observedAt.");
  return lower(item.status) === "enabled"
    ? mark(control, "PROVED", "Backups are explicitly enabled.")
    : mark(control, "BLOCKED", "Backups are not explicitly enabled.");
}

function evaluateTursoPitr(evidence) {
  const item = evidence?.turso?.pitr;
  const control = baseControl("turso.pitr", "Turso PITR restoration", item);
  if (!item) return mark(control, "UNKNOWN", "No explicit PITR restoration evidence was supplied.");
  if (!explicitEvidencePresent(item)) return mark(control, "UNKNOWN", "PITR evidence must include non-secret source and observedAt.");
  return lower(item.status) === "enabled" && lower(item.restoreTest) === "passed"
    ? mark(control, "PROVED", "PITR is enabled and restoration test passed.")
    : mark(control, "BLOCKED", "PITR is not enabled with a passed restoration test.");
}

function evaluateTursoReplica(evidence) {
  const item = evidence?.turso?.replica;
  const control = baseControl("turso.replica", "Turso replica", item);
  if (!item) return mark(control, "UNKNOWN", "No explicit replica evidence was supplied.");
  if (!explicitEvidencePresent(item)) return mark(control, "UNKNOWN", "Replica evidence must include non-secret source and observedAt.");
  return lower(item.status) === "enabled" && hasText(item.region)
    ? mark(control, "PROVED", "At least one Turso replica is explicitly enabled.")
    : mark(control, "BLOCKED", "No enabled Turso replica with region evidence was supplied.");
}

function evaluateTursoFailover(evidence) {
  const item = evidence?.turso?.failover;
  const control = baseControl("turso.failover", "Turso failover drill", item);
  if (!item) return mark(control, "UNKNOWN", "No explicit failover drill evidence was supplied.");
  if (!explicitEvidencePresent(item)) return mark(control, "UNKNOWN", "Failover evidence must include non-secret source and observedAt.");
  return lower(item.status) === "drill_passed"
    ? mark(control, "PROVED", "Failover drill has explicit passed evidence.")
    : mark(control, "BLOCKED", "Failover drill has not passed.");
}

function evaluateVercelObservability(evidence) {
  const item = evidence?.vercel?.observability;
  const control = baseControl("vercel.observability", "Vercel observability", item);
  if (!item) return mark(control, "UNKNOWN", "No explicit Vercel observability evidence was supplied.");
  if (!explicitEvidencePresent(item)) return mark(control, "UNKNOWN", "Observability evidence must include non-secret source and observedAt.");
  return lower(item.status) === "enabled"
    ? mark(control, "PROVED", "Vercel observability is explicitly enabled.")
    : mark(control, "BLOCKED", "Vercel observability is not enabled.");
}

function evaluateVercelDeploymentChecks(evidence) {
  const item = evidence?.vercel?.deploymentChecks;
  const control = baseControl("vercel.deploymentChecks", "Vercel deployment checks", item);
  const candidateSha = evidence?.candidateSha;
  if (!item) return mark(control, "UNKNOWN", "No explicit deployment-check evidence was supplied.");
  if (!explicitEvidencePresent(item)) return mark(control, "UNKNOWN", "Deployment-check evidence must include non-secret source and observedAt.");
  if (!hasText(candidateSha)) return mark(control, "UNKNOWN", "No candidate SHA was supplied to bind deployment-check evidence.");
  if (item.candidateSha !== candidateSha) {
    return mark(control, "BLOCKED", `Deployment checks evidence is not bound to candidate SHA ${candidateSha}.`);
  }
  return lower(item.status) === "enabled" && item.protectedProduction === true
    ? mark(control, "PROVED", "Deployment checks are enabled, production-protecting, and bound to the candidate SHA.")
    : mark(control, "BLOCKED", "Deployment checks are not enabled with production protection.");
}

function collectSecretFindings(value, pathParts = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectSecretFindings(entry, [...pathParts, String(index)]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => {
      const childPath = [...pathParts, key];
      if (SECRET_KEY_PATTERN.test(key) && child !== undefined && child !== null && String(child).length > 0) {
        return [{ path: childPath.join("."), reason: "secret-like key name" }];
      }
      return collectSecretFindings(child, childPath);
    });
  }
  if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
    return [{ path: pathParts.join("."), reason: "secret-like string value" }];
  }
  return [];
}

export function redactSecretLikeValues(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key) && value !== undefined && value !== null && String(value).length > 0) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretLikeValues(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactSecretLikeValues(child, childKey)]),
    );
  }
  if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
    return "[REDACTED]";
  }
  return value;
}

function summarize(controls) {
  return controls.reduce(
    (acc, control) => {
      if (control.status === "PROVED") acc.proved += 1;
      if (control.status === "BLOCKED") acc.blocked += 1;
      if (control.status === "UNKNOWN") acc.unknown += 1;
      return acc;
    },
    { proved: 0, blocked: 0, unknown: 0 },
  );
}

function verdictFrom(summary) {
  if (summary.blocked > 0) return "BLOCKED";
  if (summary.unknown > 0) return "UNKNOWN";
  return "PROVED";
}

export function evaluateReadiness(rawEvidence = {}) {
  const secretFindings = collectSecretFindings(rawEvidence);
  const evidence = redactSecretLikeValues(rawEvidence);
  const controls = CONTROL_ORDER.map((key) => {
    if (key === "turso.backups") return evaluateTursoBackups(evidence);
    if (key === "turso.pitr") return evaluateTursoPitr(evidence);
    if (key === "turso.replica") return evaluateTursoReplica(evidence);
    if (key === "turso.failover") return evaluateTursoFailover(evidence);
    if (key === "vercel.observability") return evaluateVercelObservability(evidence);
    return evaluateVercelDeploymentChecks(evidence);
  });

  if (secretFindings.length > 0) {
    controls.push({
      key: "evidence.secretHygiene",
      label: "Evidence secret hygiene",
      status: "BLOCKED",
      reason: "Evidence contains secret-like keys or values; replace with redacted proof before readiness can be proved.",
      evidence: secretFindings.map((finding) => ({
        path: finding.path,
        reason: finding.reason,
        value: "[REDACTED]",
      })),
    });
  }

  const summary = summarize(controls);
  return {
    verdict: verdictFrom(summary),
    summary,
    candidateSha: evidence.candidateSha ?? null,
    rollbackTarget: evidence.rollbackTarget ?? null,
    generatedAt: new Date().toISOString(),
    mode: "local-read-only",
    controls,
  };
}

export function loadEvidenceFile(filePath) {
  const content = readFileSync(resolve(filePath), "utf8");
  return JSON.parse(content);
}

function usage() {
  return [
    "Usage: node scripts/cloud-recovery-observability-readiness.mjs --evidence <non-secret-evidence.json> [--report-only]",
    "",
    "This checker is local/read-only. It does not call Turso, Vercel, production Firebase, paid APIs, or network services.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { evidencePath: null, reportOnly: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--report-only") {
      args.reportOnly = true;
    } else if (arg === "--evidence") {
      args.evidencePath = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.evidencePath) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  const report = evaluateReadiness(loadEvidenceFile(args.evidencePath));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return args.reportOnly || report.verdict === "PROVED" ? 0 : 1;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isCli) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
