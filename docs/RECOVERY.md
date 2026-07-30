# Firestore Recovery Runbook (F-08, F-01, F-07)

Status: **OWNER-GATED / OPEN.** Nothing in this document has been run against production. This is the
prepared runbook the owner executes; agents and automation must never run the mutating commands below
without the owner's explicit in-the-moment approval (see `CLAUDE.md` "No-Deploy Rule").

## 1. Current production state (verified live, read-only, 2026-07-29 - updated same day)

Read directly from the live `(default)` database in project `smart-inventory-scanner-app` via the
Firebase MCP `firestore_get_database` call (no write performed).

**Update (2026-07-29, later same day):** a second live Admin API read confirms PITR and delete
protection are now **VERIFIED ENABLED** (7-day continuous change history retention):

| Setting | Live value (2026-07-29, verified enabled) |
|---|---|
| `pointInTimeRecoveryEnablement` | `POINT_IN_TIME_RECOVERY_ENABLED` |
| `deleteProtectionState` | `DELETE_PROTECTION_ENABLED` |
| `versionRetentionPeriod` | `604800s` (7-day continuous change history, PITR default) |
| `freeTier` | `true` (unchanged; confirm current Firestore pricing before assuming this stays true under PITR billing) |
| `databaseEdition` | `STANDARD` |
| `locationId` | `nam5` |

Original (now-superseded) reading, kept for history: `pointInTimeRecoveryEnablement` was
`POINT_IN_TIME_RECOVERY_DISABLED`, `deleteProtectionState` was `DELETE_PROTECTION_DISABLED`, and
`versionRetentionPeriod` was `3600s` (1-hour default change history) - i.e. Section 2 below was
executed by the owner between the two reads.

Plain language: as of the 2026-07-29 update, PITR and delete protection are both live in production -
a mistaken `gcloud firestore databases delete`, a bad migration, or a bug that mass-deletes/corrupts
documents now has a 7-day window to restore from, and the database itself cannot be deleted without
first disabling delete protection. **The restore drill (Section 3) has NOT yet been run** - enabling
PITR proves the setting is on, not that a restore actually works end to end. F-08 stays open until a
drill passes and is recorded here.

Separately (F-01 / F-07), the same live read confirmed the **rules and indexes gap**: the deployed
Firestore rules are an older, less-hardened ruleset (missing the owner-role-escalation guard that the
tracked `firestore.rules` already has), and only 1 of the 3 indexes declared in the tracked
`firestore.indexes.json` is deployed (`catalogEntries(verificationStatus, firstSeenAt)` is READY;
`catalogEntries(verificationStatus, provenanceTier, updatedAt)` and `scanEvents(sessionId, createdAt)`
are NOT deployed). Section 3 below is the deploy runbook for that gap.

## 2. Enabling PITR and delete protection

### Cost note (read before enabling)

The database currently reports `freeTier: true`. Point-in-time recovery keeps 7 days of continuous
change history and is **billed separately from normal storage** (Google charges for PITR storage once
enabled; delete protection itself is free). Enabling PITR may take this database out of the free tier.
Confirm the current Firestore pricing page for the `nam5` multi-region before enabling, and set a
budget alert if desired. This is why F-08 is owner-gated rather than something engineering enables by
default.

### Option A: Firebase console (recommended, clearest UI)

1. Go to https://console.firebase.google.com/project/smart-inventory-scanner-app/firestore/databases
2. Select the `(default)` database.
3. Open **Database settings** (gear icon / "Edit database").
4. Toggle **Point-in-time recovery** to Enabled. Confirm the cost notice.
5. Toggle **Delete protection** to Enabled.
6. Save. Re-run the verification query in Section 4 to confirm both flipped.

### Option B: gcloud CLI equivalent

```bash
# Enable point-in-time recovery (7-day continuous backups)
gcloud firestore databases update \
  --database='(default)' \
  --point-in-time-recovery-enablement=POINT_IN_TIME_RECOVERY_ENABLED \
  --project=smart-inventory-scanner-app

# Enable delete protection (blocks accidental `gcloud firestore databases delete`)
gcloud firestore databases update \
  --database='(default)' \
  --delete-protection-state=DELETE_PROTECTION_ENABLED \
  --project=smart-inventory-scanner-app
```

### Option C: firebase CLI

The `firebase` CLI does not currently expose a dedicated PITR/delete-protection toggle command; use
Option A or B. (`firebase firestore:databases:update` may gain this in a future CLI version — check
`firebase firestore:databases:update --help` before assuming it is unavailable.)

## 3. Restore drill procedure (run once after enabling PITR, and periodically thereafter)

### Drill attempt log (2026-07-29/30) — BLOCKED at import, cleaned up, F-08 stays OPEN

Owner-approved in-session attempt. Findings for whoever resumes this:

1. **The exact commands below (`gcloud firestore databases restore --source-database --snapshot-time
   --destination-database`) do not exist in the installed gcloud CLI (Google Cloud SDK 577.0.0,
   stable/alpha/beta channels all checked).** That flag set is not supported; `gcloud firestore
   databases restore` only supports `--source-backup` (restoring from a scheduled Backup), and this
   project has **zero backups and no backup schedule** (`gcloud firestore backups list` /
   `backups schedules list` both empty). PITR-window restore-to-new-database must instead go through
   **export at `--snapshot-time` -> import into a new database** (`gcloud firestore export` /
   `gcloud firestore import`), which is what was actually run.
2. **Export succeeded.** Snapshot time `2026-07-30T03:15:00Z` (within the 7-day PITR window;
   `earliestVersionTime` was `2026-07-30T00:15:00Z` at the time). Exported to a new scratch bucket
   `gs://smart-inventory-scanner-app-drill-20260730` (created for this drill, `us` multi-region).
   4,159,353 documents, started `03:25:13Z`, finished `03:37:43Z` (~12.5 min) — this equals the full
   `catalogEntries` public-catalog mirror plus tenant data, i.e. the export is NOT scoped to one
   business; a faster future drill should pass `--collection-ids=businesses` (and its subcollections
   are nested under it so this alone may not filter enough — `--namespace-ids` does not help either,
   Firestore doesn't namespace by business here) or accept the full-corpus export time.
3. **New scratch database `drill-20260729` created successfully** (delete-protection explicitly
   DISABLED at creation so cleanup would not be blocked).
4. **Import into `drill-20260729` failed 4 times with an identical `PERMISSION_DENIED`** referencing
   only the bucket name (`Service account does not have access to Google Cloud Storage file:
   /smart-inventory-scanner-app-drill-20260730`), even after: (a) granting the Firestore service agent
   (`service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com`) `roles/storage.objectAdmin` on the
   bucket, waiting up to ~2.5 min for IAM propagation, retrying; (b) escalating to
   `roles/storage.admin` on the same bucket (covers bucket-level `storage.buckets.get` that
   `objectAdmin` alone does not grant) and retrying again. Same error every time, unchanged wording.
   Notably, **export worked with ZERO explicit IAM grant** on the same service agent/bucket, which is
   inconsistent with import's requirement — suggests either an org policy / VPC-SC restriction specific
   to cross-database import, a different identity being used for import than for export, or a
   permission scope beyond bucket IAM (e.g. a project-level `roles/datastore.importExportAdmin` grant
   that export doesn't need but import does, or a security perimeter blocking the newly-created
   scratch database specifically). Not root-caused within this session's time budget.
5. **Cleanup completed:** the scratch bucket `gs://smart-inventory-scanner-app-drill-20260730` and all
   its export objects were deleted (`gcloud storage rm -r`), and the empty scratch database
   `drill-20260729` was deleted via the Firebase MCP `firestore_delete_database` tool (confirmed via
   `deleteTime` in the response and a follow-up `gcloud firestore databases list` showing only
   `(default)` remains). No ongoing cost from this attempt. The `(default)` production database was
   never written to or touched destructively at any point.
6. **F-08 stays OPEN.** PITR/delete-protection enablement (Section 2) is proven; a full restore has
   NOT been proven end-to-end. Exact resume path for the owner or a future session: (a) diagnose the
   import PERMISSION_DENIED root cause (check VPC Service Controls / org policy on the project, or try
   granting `roles/datastore.importExportAdmin` at the project level to the Firestore service agent
   before the bucket-level grants, or test import into a bucket that already existed before this drill
   rather than one created fresh in the same session), then (b) re-run export+import with a fresh
   snapshot time and a fresh scratch database id, spot-check a known business's documents, record
   elapsed time here, and delete the scratch resources again.



Firestore PITR restores **into a brand-new database**, never in place over the live one, so a drill
cannot damage production data. Follow this sequence:

1. Pick a recent timestamp within the retention window (7 days after enabling) and a scratch
   destination database id, e.g. `restore-drill-<date>`.
2. Run the restore:
   ```bash
   gcloud firestore databases restore \
     --source-database='projects/smart-inventory-scanner-app/databases/(default)' \
     --snapshot-time='2026-08-05T12:00:00Z' \
     --destination-database='restore-drill-2026-08-05' \
     --project=smart-inventory-scanner-app
   ```
3. Once the restore operation completes, open the new `restore-drill-*` database in the console (or via
   `firestore_get_database` / `firestore_list_collections`) and spot-check a known business's
   `businesses/{bid}/products` and `inventoryCounts` documents against what you expect for that
   timestamp.
4. Record the result (pass/fail, elapsed time, any surprises) in this file or `PROGRESS.md`.
5. Delete the scratch `restore-drill-*` database when done so it does not accrue storage cost:
   ```bash
   gcloud firestore databases delete --database='restore-drill-2026-08-05' \
     --project=smart-inventory-scanner-app
   ```
   (Delete protection, if enabled on this scratch database too, must be disabled first the same way as
   Section 2 before this delete will succeed — that is expected and is the feature working.)

## 4. Rules + indexes deploy command sheet (F-01, F-07)

The tracked `firestore.rules` and `firestore.indexes.json` in this repo are already the hardened,
correct source (verified 2026-07-29: the owner-role-escalation guard and the counter/count envelope
rules are present; all 3 composite indexes are declared). The gap is that **production has not been
redeployed** since an older ruleset was pushed — this is a deploy gap, not a source gap. Firestore rules
and indexes deploy independently of the Vercel app, so the app can be fully current while these lag.

### Pre-deploy check

Confirm you are targeting the right project and the tracked files are what you expect:

```bash
firebase use prod          # resolves to smart-inventory-scanner-app via .firebaserc
firebase firestore:rules:get   # optional: eyeball current live rules before overwriting
```

### Deploy

```bash
firebase deploy --only firestore:rules --project prod
firebase deploy --only firestore:indexes --project prod
```

(Equivalently, the existing single-shot script `npm run deploy:rules:prod` runs
`firebase deploy --only firestore:rules,firestore:indexes --project smart-inventory-scanner-app` — same
effect, one command instead of two.)

### Post-deploy verification (required, do not skip)

1. **Rules hash/content check** — re-fetch live rules and diff against the tracked file:
   ```bash
   firebase firestore:rules:get --project prod > /tmp/live-rules-after-deploy.txt
   diff /tmp/live-rules-after-deploy.txt firestore.rules
   ```
   Expect no diff (or only the header comment ordering, which the CLI preserves verbatim in practice).
2. **Index readiness check** — new composite indexes take time to build (minutes to hours depending on
   collection size). Poll until every declared index reports `READY`:
   ```bash
   firebase firestore:indexes --project prod
   ```
   Confirm all 3 indexes are present and `state: READY`:
   - `catalogEntries(verificationStatus ASC, firstSeenAt DESC)`
   - `catalogEntries(verificationStatus ASC, provenanceTier ASC, updatedAt DESC)`
   - `scanEvents(sessionId ASC, createdAt ASC)`
3. **Functional smoke check** — sign in as an admin-role test account against production and confirm
   the admin can no longer grant itself or another account the `owner` role (the exact regression F-01
   closes). This should be denied after the new rules are live; it was allowed under the old live rules.

## 5. Finding closure status

- **F-08** (PITR / delete protection): Section 2 is now DONE - PITR and delete protection are verified
  ENABLED in production as of 2026-07-29 (see Section 1 update). Stays **OPEN**: the restore drill
  attempted 2026-07-29/30 got as far as a successful PITR-window export but was BLOCKED at the
  import-into-scratch-database step by an unresolved `PERMISSION_DENIED` (see Section 3 drill log for
  full diagnosis and exact resume steps). All scratch resources (bucket, database) were cleaned up;
  production `(default)` was never touched destructively.
- **F-01 / F-07** (hardened rules + missing indexes deployed): **CLOSED 2026-07-29**, owner-approved
  in-session. Ran `npm run deploy:rules:prod` (= `firebase deploy --only firestore:rules,firestore:indexes
  --project smart-inventory-scanner-app`). Deploy output: "latest version of firestore.rules already up
  to date, skipping upload" (rules were already current on the live project by the time this run executed)
  and "deployed indexes in firestore.indexes.json successfully". Post-deploy verification via the Firebase
  MCP `firebase_get_security_rules` / `firestore_list_indexes` tools (the documented `firebase
  firestore:rules:get` CLI command does not exist in the installed Firebase CLI version - use the MCP
  tool or the console instead) confirms: live rules text is byte-identical to tracked `firestore.rules`
  (493 lines, including the owner-role-escalation guard in `businessMembers.update` and all counter/count
  envelope functions), and all 3 declared composite indexes report `state: READY`
  (`catalogEntries(verificationStatus, firstSeenAt)`, `catalogEntries(verificationStatus, provenanceTier,
  updatedAt)`, `scanEvents(sessionId, createdAt)`). Functional admin-self-escalation-denied smoke check
  (Section 4 step 3) was NOT run live against a real admin account in this session - out of scope for a
  headless CLI drill; the rules-text match is the evidence of record for F-01.

No agent may mark either finding CODE-CLOSED without owner-approved evidence; this closure was recorded
after an explicit owner-approved production deploy + MCP-verified post-deploy check in this session.
