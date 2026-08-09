# Firestore Recovery Runbook (F-08, F-01, F-07)

Status: **OWNER-GATED.** F-01/F-07 (rules+indexes) CLOSED 2026-07-29 and F-08 (PITR + restore proof)
CLOSED 2026-08-07, both via explicit owner-approved in-session runs (see Section 5). This remains the
prepared runbook the owner executes; agents and automation must never run the mutating commands below
(restore, import, IAM grants, backup schedule changes, rules deploys) without the owner's explicit
in-the-moment approval (see `CLAUDE.md` "No-Deploy Rule").

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
first disabling delete protection. **The restore drill (Section 3) PASSED end to end on 2026-08-07** -
a PITR-window export was imported into a scratch database and spot-checked against the live source;
F-08 is now CLOSED (see the 2026-08-07 drill log in Section 3 and the closure in Section 5). A weekly
scheduled backup is also live (Section 2.1), so future restores use the simpler `--source-backup` path.

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

### 2.1 Scheduled backups (LIVE since 2026-08-07)

A **weekly scheduled backup** is now live on the `(default)` database, created in the 2026-08-07 drill.
This is what makes the simple `gcloud firestore databases restore --source-backup` path available (the
only restore mode the installed CLI supports); before this, the project had zero backups and no schedule.

- Schedule id: `projects/smart-inventory-scanner-app/databases/(default)/backupSchedules/deb171e8-11ba-4beb-8de8-9381054abd0a`
- Recurrence: weekly, Sunday (UTC). Retention: 28 days (`2419200s`), i.e. 4 weekly backups retained.
- First backup lands the next Sunday after creation; verify with `gcloud firestore backups list --project=smart-inventory-scanner-app`.

Command used (note the real SDK flags — `--recurrence=weekly` + `--day-of-week=SUN`, NOT the
`--weekly-recurrence` form; verify with `gcloud firestore backups schedules create --help`):

```bash
gcloud firestore backups schedules create \
  --database='(default)' --project=smart-inventory-scanner-app \
  --recurrence=weekly --day-of-week=SUN --retention=28d
# verify:
gcloud firestore backups schedules list --database='(default)' --project=smart-inventory-scanner-app
```

Cost note (cost-truth rule): backup storage bills per GiB-month at the Firestore backup rate. The
`(default)` database is single-digit GiB (dominated by the ~4M-doc `retailCatalogEntries` mirror), and
up to 4 weekly backups are retained, so expect a small monthly figure — but confirm the real number in
the billing console after the first backup lands; do not quote a wallet figure before that.

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
   **[RESOLVED 2026-08-07 — the resume steps above were executed; see the passing drill log below.]**

### Drill 2026-08-07 — PASSED end to end (F-08 root-caused and CLOSED)

Owner-pre-approved in-session. The 2026-07-29/30 import `PERMISSION_DENIED` was root-caused and fixed.

1. **Root cause (confirmed, not guessed).** A read-only IAM check showed the Firestore service agent
   `service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com` held ONLY `roles/firestore.serviceAgent`
   and was MISSING `roles/datastore.importExportAdmin`. This is exactly the project-level datastore
   permission hypothesized last time: export needs it implicitly but import requires it explicitly, which
   is why export worked with zero grants while every bucket-level storage grant left import failing. No
   org policies (`gcloud resource-manager org-policies list` empty) and no VPC-SC perimeter (personal
   project, no org) — so IAM was the whole story. Fix (project-level grant):
   ```bash
   gcloud projects add-iam-policy-binding smart-inventory-scanner-app \
     --member="serviceAccount:service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com" \
     --role="roles/datastore.importExportAdmin"
   ```
   This grant is RETAINED (not rolled back) so future drills/restores work without re-granting; it is a
   standard capability for the Firestore service agent. Rollback if ever desired: same command with
   `remove-iam-policy-binding`.
2. **Export succeeded.** Snapshot `2026-08-07T14:09:00Z` (within the 7-day PITR window;
   `earliestVersionTime` was `2026-07-31T15:10:00Z`). Bucket `gs://smart-inventory-scanner-app-drill-20260807`
   (`us`, created for the drill). Scoped to the REAL top-level collections
   `--collection-ids='businesses,businessMembers,businessProvisioningRequests,userProfiles,catalogEntries'`
   — this deliberately EXCLUDES the ~4M-doc `retailCatalogEntries` public mirror (a rebuildable shared
   corpus, not customer data), cutting the export from the full-corpus ~12.5 min to about a minute.
   **78,979 documents**, completed in roughly a minute. (Data-model note corrected from the last drill:
   scan data is NOT nested as `businesses/{bid}/products|scanEvents|inventoryCounts` subcollections —
   those don't exist; the real top-level collections are `businessMembers`, `businessProvisioningRequests`,
   `businesses`, `catalogEntries`, `retailCatalogEntries`, `userProfiles`.)
3. **Scratch database `drill-20260807` created** (`nam5`, delete protection explicitly DISABLED —
   `deleteProtectionState: DELETE_PROTECTION_DISABLED` verified before import so cleanup would not block).
4. **Import SUCCEEDED on the FIRST attempt** after the IAM grant — no `PERMISSION_DENIED`. All **78,979
   documents** imported into `drill-20260807` (import operation reached `operationState: SUCCESSFUL`,
   `completedWork: 78979`), roughly ten minutes wall-clock (import is slower than export). The single
   missing IAM role was the entire blocker.
5. **Spot-check verification (read-only, scratch DB via Firebase MCP `firestore_query_collection` against
   database `drill-20260807`).** The `businesses` collection returned an IDENTICAL 55-document set in the
   restored scratch DB and the live `(default)` source (byte-for-byte, down to the last doc
   `businesses/loop8-biz` "Loop8 Co") — strong point-in-time fidelity. Three concrete restored documents:
   - `businesses/047b7b93-87e4-459b-993e-f54b0570fd86` — name "TEACH-BOT Tire Shop", createdBy
     `kdtJl9wO2XZ6UpUeFmLvU0zn0lB2`, createdAt `2026-07-26T16:22:07.740Z`.
   - `catalogEntries/000000191180` — "Bridgestone Dueler A T Revo Uni-T 265/70R17 121/118R", brand
     Bridgestone, barcodeType `upca`, `verificationStatus: verified`.
   - `catalogEntries/0051342128136` — "Continental Extremecontact Dw 265/40R17 94W", brand Continental,
     barcodeType `ean13`, `verificationStatus: verified`.
   Counts: `businesses` = 55 docs (source and restore identical); total restored across the 5 exported
   collections = 78,979 docs (`catalogEntries` is the bulk, ~78,900 tire-corpus rows).
6. **Cleanup completed.** Scratch bucket deleted (`gcloud storage rm -r`; a follow-up
   `gcloud storage buckets describe` returns 404). Scratch DB `drill-20260807` deleted via Firebase MCP
   `firestore_delete_database` (deleteTime `2026-08-07T15:24:33Z`). Final
   `gcloud firestore databases list` shows only `(default)` (still `DELETE_PROTECTION_ENABLED`,
   never touched destructively at any point). No ongoing cost from the drill itself.

### Future restore — the two REAL paths (the installed SDK 577.0.0)

Firestore restores **into a brand-new database**, never in place over the live one, so a drill cannot
damage production. `gcloud firestore databases restore` supports ONLY `--source-backup` (there is no
`--source-database`/`--snapshot-time` restore form — that flag set does not exist in this SDK).

**Path A — from a scheduled backup (simplest; available now via the Section 2.1 weekly schedule):**

```bash
gcloud firestore backups list --project=smart-inventory-scanner-app          # find the backup name
gcloud firestore databases restore \
  --source-backup='projects/smart-inventory-scanner-app/locations/nam5/backups/<BACKUP_ID>' \
  --destination-database='restore-drill-<date>' \
  --project=smart-inventory-scanner-app
```

**Path B — PITR-window point-in-time (export-at-snapshot then import; proven 2026-08-07):**

```bash
# 1. confirm the snapshot is inside the PITR window
gcloud firestore databases describe --database='(default)' \
  --project=smart-inventory-scanner-app --format="value(earliestVersionTime)"
# 2. export at a whole-minute RFC3339 snapshot within the window (scope with --collection-ids to skip
#    the ~4M-doc retailCatalogEntries mirror; omit --collection-ids for a full ~12.5-min export)
gcloud firestore export gs://smart-inventory-scanner-app-drill-<date>/export-1 \
  --database='(default)' --project=smart-inventory-scanner-app \
  --snapshot-time='<RFC3339>' \
  --collection-ids='businesses,businessMembers,businessProvisioningRequests,userProfiles,catalogEntries'
# 3. create a scratch DB with delete protection OFF (no --delete-protection flag), then import
gcloud firestore databases create --database=drill-<date> \
  --project=smart-inventory-scanner-app --location=nam5 --type=firestore-native
gcloud firestore import gs://smart-inventory-scanner-app-drill-<date>/export-1 \
  --database=drill-<date> --project=smart-inventory-scanner-app
```

Then spot-check the scratch DB (Firebase MCP `firestore_query_collection` with `database=drill-<date>`;
set the MCP active project to `smart-inventory-scanner-app` first, since it defaults to
`smart-inventory-preview`), record evidence here, and delete the scratch bucket + scratch DB when done.
Prerequisite for import: the Firestore service agent must hold project-level
`roles/datastore.importExportAdmin` (granted 2026-08-07, retained).

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

- **F-08** (PITR / delete protection + restore proof): **CLOSED 2026-08-07**, owner-pre-approved
  in-session. PITR and delete protection were verified ENABLED 2026-07-29 (Section 1), and the restore
  drill now PASSES end to end (Section 3, "Drill 2026-08-07"). Root cause of the 2026-07-29/30 import
  block: the Firestore service agent was missing project-level `roles/datastore.importExportAdmin` (had
  only `roles/firestore.serviceAgent`); granting it made import succeed on the first attempt. Evidence of
  record: PITR-window export at snapshot `2026-08-07T14:09:00Z` (78,979 docs, ~1 min) imported into
  scratch DB `drill-20260807` (78,979 docs, ~10 min), spot-checked against live source — `businesses`
  collection identical 55-doc set, and three restored documents confirmed:
  `businesses/047b7b93-87e4-459b-993e-f54b0570fd86` ("TEACH-BOT Tire Shop"),
  `catalogEntries/000000191180` (Bridgestone, verified), `catalogEntries/0051342128136` (Continental,
  verified). A weekly scheduled backup is live (Section 2.1) so future restores use `--source-backup`.
  All scratch resources (bucket + `drill-20260807` DB) were deleted; only `(default)` remains and it was
  never touched destructively. The IAM grant is retained so future drills need no re-grant.
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
