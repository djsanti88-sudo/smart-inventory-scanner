import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  evaluateReadiness,
  loadEvidenceFile,
  redactSecretLikeValues,
} from "./cloud-recovery-observability-readiness.mjs";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/cloud-recovery-observability-readiness.mjs");

function runScript(args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
}

function writeEvidence(evidence) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scanbin-readiness-evidence-"));
  const evidencePath = path.join(dir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return evidencePath;
}

function provedEvidence() {
  return {
    candidateSha: "abc123",
    rollbackTarget: "prod-previous-2026-08-10",
    turso: {
      backups: { status: "enabled", observedAt: "2026-08-10T12:00:00Z", source: "turso dashboard screenshot redacted" },
      pitr: { status: "enabled", restoreTest: "passed", observedAt: "2026-08-10T12:05:00Z", source: "restored scratch db row-count match" },
      replica: { status: "enabled", region: "iad", observedAt: "2026-08-10T12:10:00Z", source: "replica list redacted" },
      failover: { status: "drill_passed", observedAt: "2026-08-10T12:15:00Z", source: "owner-approved local drill transcript" },
    },
    vercel: {
      observability: { status: "enabled", observedAt: "2026-08-10T12:20:00Z", source: "project observability settings screenshot redacted" },
      deploymentChecks: { status: "enabled", protectedProduction: true, candidateSha: "abc123", observedAt: "2026-08-10T12:25:00Z", source: "deployment protection settings screenshot redacted" },
    },
  };
}

describe("cloud recovery and observability readiness checker", () => {
  it("returns PROVED only when every required control has explicit non-secret proof for the candidate SHA", () => {
    const report = evaluateReadiness(provedEvidence());

    expect(report.verdict).toBe("PROVED");
    expect(report.summary).toEqual({ proved: 6, blocked: 0, unknown: 0 });
    expect(report.controls.map((control) => control.key)).toEqual([
      "turso.backups",
      "turso.pitr",
      "turso.replica",
      "turso.failover",
      "vercel.observability",
      "vercel.deploymentChecks",
    ]);
  });

  it("is BLOCKED when explicit evidence says a required control is disabled or failed", () => {
    const evidence = provedEvidence();
    evidence.turso.pitr.status = "disabled";

    const report = evaluateReadiness(evidence);

    expect(report.verdict).toBe("BLOCKED");
    expect(report.controls.find((control) => control.key === "turso.pitr")).toMatchObject({
      status: "BLOCKED",
      reason: "PITR is not enabled with a passed restoration test.",
    });
  });

  it("is UNKNOWN rather than inferred when explicit evidence is missing", () => {
    const evidence = provedEvidence();
    delete evidence.turso.failover;

    const report = evaluateReadiness(evidence);

    expect(report.verdict).toBe("UNKNOWN");
    expect(report.controls.find((control) => control.key === "turso.failover")).toMatchObject({
      status: "UNKNOWN",
      reason: "No explicit failover drill evidence was supplied.",
    });
  });

  it("blocks Vercel deployment checks when the evidence is for a different SHA", () => {
    const evidence = provedEvidence();
    evidence.vercel.deploymentChecks.candidateSha = "def456";

    const report = evaluateReadiness(evidence);

    expect(report.verdict).toBe("BLOCKED");
    expect(report.controls.find((control) => control.key === "vercel.deploymentChecks")).toMatchObject({
      status: "BLOCKED",
      reason: "Deployment checks evidence is not bound to candidate SHA abc123.",
    });
  });

  it("redacts secret-like values and reports a BLOCKED secret-leak finding", () => {
    const evidence = provedEvidence();
    evidence.turso.backups.token = "secret-token-value";
    evidence.vercel.observability.source = "contains sk_live_secret";

    const report = evaluateReadiness(evidence);
    const serialized = JSON.stringify(report);

    expect(report.verdict).toBe("BLOCKED");
    expect(report.controls.find((control) => control.key === "evidence.secretHygiene")).toMatchObject({
      status: "BLOCKED",
    });
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("sk_live_secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("loads JSON evidence files without requiring live network or paid API calls", () => {
    const evidencePath = writeEvidence(provedEvidence());

    const evidence = loadEvidenceFile(evidencePath);

    expect(evidence.candidateSha).toBe("abc123");
  });

  it("CLI exits 0 for PROVED and prints JSON without secrets", () => {
    const evidencePath = writeEvidence(provedEvidence());

    const result = runScript(["--evidence", evidencePath]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("PROVED");
    expect(result.stderr).toBe("");
  });

  it("CLI exits 1 for UNKNOWN unless explicitly run as report-only", () => {
    const evidence = provedEvidence();
    delete evidence.vercel.observability;
    const evidencePath = writeEvidence(evidence);

    const blocked = runScript(["--evidence", evidencePath]);
    const reportOnly = runScript(["--evidence", evidencePath, "--report-only"]);

    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stdout).verdict).toBe("UNKNOWN");
    expect(reportOnly.status).toBe(0);
  });

  it("redactSecretLikeValues recursively masks risky keys and token-shaped strings", () => {
    const redacted = redactSecretLikeValues({
      nested: {
        apiKey: "abc123",
        note: "safe note",
        transcript: "Authorization: Bearer very-secret-token",
      },
    });

    expect(redacted.nested.apiKey).toBe("[REDACTED]");
    expect(redacted.nested.note).toBe("safe note");
    expect(redacted.nested.transcript).toBe("[REDACTED]");
  });

  it("redacts credentials embedded in URL userinfo or sensitive query parameters", () => {
    const redacted = redactSecretLikeValues({
      queryProof: "https://example.invalid/settings?token=raw-secret-value",
      userInfoProof: "https://operator:password@example.invalid/settings",
      safeProof: "https://example.invalid/settings?view=backups",
    });

    expect(redacted.queryProof).toBe("[REDACTED]");
    expect(redacted.userInfoProof).toBe("[REDACTED]");
    expect(redacted.safeProof).toBe("https://example.invalid/settings?view=backups");
  });
});
