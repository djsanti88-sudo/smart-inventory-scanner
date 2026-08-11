# Cloud recovery and observability readiness runbook

This runbook is owner-gated and fail-closed. It is for proving that a specific Scanbin candidate SHA has enough cloud recovery and observability evidence to be considered release-ready.

Do not run live mutations, deploys, production restores, production writes, or paid/live provider calls unless the owner explicitly approves that exact action in the current session.

## Readiness rule

The readiness checker can only return:

- `PROVED`: every required control has explicit, non-secret evidence.
- `BLOCKED`: at least one control has explicit failed/disabled/mismatched evidence, or the evidence contains secret-like values.
- `UNKNOWN`: evidence is missing or incomplete.

Never infer readiness from project names, CLI login state, historical notes, provider defaults, screenshots without timestamps, or verbal memory. Missing evidence is `UNKNOWN`.

## Required non-secret evidence file

Create a local JSON file outside version control, for example `.tmp/cloud-readiness-evidence.json`. Do not include tokens, URLs with embedded credentials, API keys, service account JSON, cookies, bearer headers, or customer data.

Minimum shape:

```json
{
  "candidateSha": "exact-candidate-git-sha",
  "rollbackTarget": "exact-known-good-production-sha-or-deployment-id",
  "turso": {
    "backups": {
      "status": "enabled",
      "observedAt": "2026-08-10T00:00:00Z",
      "source": "redacted dashboard screenshot or command transcript"
    },
    "pitr": {
      "status": "enabled",
      "restoreTest": "passed",
      "observedAt": "2026-08-10T00:00:00Z",
      "source": "scratch restore proof with row-count/checksum match, no secrets"
    },
    "replica": {
      "status": "enabled",
      "region": "iad",
      "observedAt": "2026-08-10T00:00:00Z",
      "source": "redacted replica settings proof"
    },
    "failover": {
      "status": "drill_passed",
      "observedAt": "2026-08-10T00:00:00Z",
      "source": "owner-approved failover drill transcript or evidence"
    }
  },
  "vercel": {
    "observability": {
      "status": "enabled",
      "observedAt": "2026-08-10T00:00:00Z",
      "source": "redacted Vercel observability settings proof"
    },
    "deploymentChecks": {
      "status": "enabled",
      "protectedProduction": true,
      "candidateSha": "exact-candidate-git-sha",
      "observedAt": "2026-08-10T00:00:00Z",
      "source": "redacted Vercel deployment checks/protection proof"
    }
  }
}
```

## Local read-only checker

Run:

```powershell
node scripts/cloud-recovery-observability-readiness.mjs --evidence .tmp/cloud-readiness-evidence.json
```

Expected behavior:

- Exit `0` only when the report verdict is `PROVED`.
- Exit `1` when the report verdict is `BLOCKED` or `UNKNOWN`.
- Use `--report-only` only when collecting a report without treating non-proved status as command failure.

The checker is local/read-only. It does not call Turso, Vercel, Firebase, production systems, paid APIs, or network services.

## Owner-gated verification checklist

The owner must approve each live/cloud step before it is run. Record only redacted evidence in the JSON file.

1. Candidate SHA
   - Verify the exact Git SHA intended for release.
   - Verify the working tree and release source are not mixed with unrelated uncommitted work.
   - Bind Vercel deployment-check evidence to this exact SHA.

2. Rollback target
   - Identify the exact known-good production deployment ID or Git SHA.
   - Confirm rollback instructions are current and executable by the owner-approved operator.
   - Do not proceed if the rollback target is missing, ambiguous, or untested.

3. Turso backups
   - Verify backups are enabled for the production database.
   - Capture redacted evidence showing status and timestamp.

4. Turso PITR restoration
   - Restore to a scratch/non-production database only after owner approval.
   - Verify row counts, schema presence, and an application-relevant checksum or sampled invariant.
   - Do not put restored customer rows or database URLs in the evidence file.

5. Turso replica and failover
   - Verify at least one replica exists and note its region.
   - Run failover drills only with explicit owner approval and a rollback path.
   - If no approved drill was performed, record `UNKNOWN`, not `PROVED`.

6. Vercel observability
   - Verify observability is enabled for the project/environment that will receive the candidate SHA.
   - Capture redacted settings proof; do not include auth cookies or tokens.

7. Vercel deployment checks
   - Verify production-protecting deployment checks are enabled.
   - Verify checks apply to the candidate SHA, not a stale deployment.
   - Verify a failed check blocks production promotion.

8. Final gate
   - Run the local checker against the redacted evidence file.
   - Treat anything except `PROVED` as not release-ready.
   - Keep the JSON report with release evidence; do not commit secret-bearing raw transcripts.
