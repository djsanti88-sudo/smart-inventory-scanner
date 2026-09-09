# Recovery runbook

This runbook covers Firestore protection, restore drills, and rules/index recovery. It contains no
credentials and grants no production authority. Every live mutation, restore, deploy, cleanup, or
scratch-resource deletion requires explicit owner approval.

## Current evidence boundary

The last recorded successful drill was August 7, 2026: a PITR-window export was imported into a new
scratch database, representative documents matched, and scratch resources were removed. Historical
details remain in Git. This proves the procedure worked then, not that current backups, IAM, rules, or
indexes are healthy now. Reverify live state before relying on it.

## Protection checks

Read-only checks should establish:

- point-in-time recovery is enabled and the earliest recoverable time is plausible;
- delete protection is enabled on production;
- a recent scheduled backup exists;
- the Firestore service agent still has the import/export role required by the drill;
- the intended Firebase project is `smart-inventory-scanner-app`.

Record the command, timestamp, project/database, output summary, and operator. Never include tokens or
service-account material.

## Restore paths

Firestore restores into a new database. Never overwrite the production `(default)` database during a
drill.

### Scheduled backup

```bash
gcloud firestore backups list --project=smart-inventory-scanner-app
gcloud firestore databases restore \
  --source-backup='projects/smart-inventory-scanner-app/locations/nam5/backups/<BACKUP_ID>' \
  --destination-database='restore-drill-<date>' \
  --project=smart-inventory-scanner-app
```

### PITR snapshot

1. Read `earliestVersionTime` and choose a whole-minute RFC3339 snapshot inside the window.
2. Export the required collections to a dedicated scratch bucket.
3. Create a new scratch Firestore database with delete protection off.
4. Import the export into that scratch database.
5. Compare document counts and representative tenant, membership, catalog, scan, and count records.
6. Record evidence, then remove scratch resources only with explicit approval.

Confirm the installed `gcloud` command syntax with `gcloud firestore --help` before a live drill;
cloud CLI flags are version-sensitive.

## Rules and indexes

The tracked sources are `firestore.rules` and `firestore.indexes.json`. Vercel deploys do not deploy
either file.

Local proof:

```bash
npm run test:firebase
```

Production deploy, owner-gated:

```bash
npm run deploy:rules:prod
```

After an approved deploy:

1. Fetch or inspect the live rules through an authenticated supported tool and compare them with the
   tracked file.
2. Confirm every declared composite index exists and reaches `READY`.
3. Run the relevant authenticated authorization smoke, including cross-tenant denial and prohibited
   role escalation.
4. Record exact project, revision, evidence, and any untested functional lane.

Do not mark recovery or parity complete from a command's exit code alone.

## Incident sequence

1. Stop the damaging writer or release path.
2. Preserve logs, timestamps, affected tenant scope, and candidate restore time.
3. Choose rollback, targeted repair, scheduled-backup restore, or PITR export/import based on evidence.
4. Restore into isolation first and validate counts, tenant boundaries, and identity data.
5. Obtain explicit approval for production mutation.
6. Reconcile restored data, audit records, pending client writes, and deployment state.
7. Add a regression test or durable guard for the failure mode.
