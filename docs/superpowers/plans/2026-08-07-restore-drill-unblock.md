# Firestore Restore Drill Unblock (F-08) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **EVERY task in this plan touches the production GCP project (`smart-inventory-scanner-app`) and is OWNER-GATED - no task runs without explicit owner approval in the moment.** Nothing here writes to the production `(default)` database; all mutation targets are scratch resources (a drill bucket, a scratch database, IAM grants, a backup schedule).

**Goal:** Prove end to end that a Firestore backup can actually be restored (close F-08), and leave behind a scheduled weekly backup so future restores use the simple `--source-backup` path.

**Architecture:** Three-pronged: (1) fix the import `PERMISSION_DENIED` root cause from the 2026-07-29/30 drill (most likely missing project-level `roles/datastore.importExportAdmin` on the Firestore service agent - export needs fewer perms than import, which matches the observed asymmetry); (2) re-run export-at-snapshot -> import-into-scratch with a tenant-scoped collection filter to cut the 12.5-minute full-corpus export; (3) create a weekly scheduled backup so `gcloud firestore databases restore --source-backup` (the only restore mode the installed CLI supports) becomes available. Verify by spot-checking a known business's documents in the scratch DB, then clean up and close F-08 in `docs/RECOVERY.md`.

**Tech Stack:** gcloud CLI (Google Cloud SDK 577.0.0), Firebase MCP tools (`firestore_list_collections`, `firestore_query_collection`, `firestore_delete_database`), `docs/RECOVERY.md` as the runbook of record.

## Global Constraints

- OWNER GATE: every `gcloud`/`firebase`/MCP call against project `smart-inventory-scanner-app` needs explicit owner approval in this session before running. Present the exact command first.
- The production `(default)` database is READ-ONLY throughout (export reads; nothing else touches it). Any command containing `--database='(default)'` in a mutating verb is forbidden.
- All scratch resources are created with delete-protection DISABLED and are deleted at the end (verified, like the 2026-07-29 cleanup).
- Cost truth rule: backup storage and the export bucket bill per GiB-month. Report the observed sizes; do not quote a wallet number without the billing console.
- Known-good facts from the last drill (do not re-derive): PITR is ENABLED (7-day window); `gcloud firestore databases restore` supports ONLY `--source-backup`; PITR-window restore must go export-at-snapshot-time -> import; export worked with ZERO extra IAM; import failed 4x with `PERMISSION_DENIED` on the bucket even after `roles/storage.objectAdmin` and `roles/storage.admin` bucket grants. Service agent: `service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com`.

## File Structure

- Modify: `docs/RECOVERY.md` (drill log Section 3, finding status Section 5)
- Modify: `REPO_HEALTH.md` (stale "backup/recovery readiness is unverified" line at ~126-127)
- Modify: `PROGRESS.md` (dated checkpoint)
- No app code changes in this plan.

---

### Task 1: Root-cause the import PERMISSION_DENIED (diagnosis, mostly read-only)

**Files:**
- Modify: `docs/RECOVERY.md` Section 3 (append findings)

**Interfaces:**
- Produces: a confirmed diagnosis line in RECOVERY.md and (if needed) one IAM grant that Task 2 depends on.

- [ ] **Step 1 (read-only): Check current IAM on the service agent**

```bash
gcloud projects get-iam-policy smart-inventory-scanner-app \
  --flatten="bindings[].members" \
  --filter="bindings.members:service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com" \
  --format="table(bindings.role)"
```

Expected: shows whether `roles/datastore.importExportAdmin` is present. Hypothesis: it is NOT - export succeeds without it but import requires the service agent to read bucket objects across the import flow with project-level scope (matches the exact asymmetry observed 2026-07-29: bucket-level `storage.admin` was not enough, suggesting the missing permission is a project-level datastore one, not a storage one).

- [ ] **Step 2 (read-only): Check for org policy / VPC-SC interference**

```bash
gcloud resource-manager org-policies list --project=smart-inventory-scanner-app
gcloud access-context-manager perimeters list 2>&1 || echo "no VPC-SC visibility (fine for a personal project)"
```

Expected: empty/none for a personal Firebase project. If a perimeter exists, STOP and record it - that changes the whole approach.

- [ ] **Step 3 (OWNER GATE - IAM mutation): Grant the missing role (only if Step 1 shows it absent)**

```bash
gcloud projects add-iam-policy-binding smart-inventory-scanner-app \
  --member="serviceAccount:service-368038862704@gcp-sa-firestore.iam.gserviceaccount.com" \
  --role="roles/datastore.importExportAdmin"
```

Rollback (run at cleanup if the owner wants the grant removed): same command with `remove-iam-policy-binding`.

- [ ] **Step 4: Record the diagnosis in RECOVERY.md Section 3** (append a dated bullet: what was found, what was granted, rollback command).

---

### Task 2: Re-run the drill - export at snapshot, import into scratch, verify (OWNER GATE)

**Files:**
- Modify: `docs/RECOVERY.md` Section 3 (drill log)

**Interfaces:**
- Consumes: IAM state from Task 1.
- Produces: a scratch database `drill-YYYYMMDD` containing restored data; verification evidence for Task 4's doc closure.

- [ ] **Step 1 (OWNER GATE - creates bucket): Create the drill bucket** (reuse-friendly name; also tests the "fresh bucket in same session" theory from the last drill - if import still fails, retry with a pre-existing bucket)

```bash
gcloud storage buckets create gs://smart-inventory-scanner-app-drill-$(date +%Y%m%d) \
  --project=smart-inventory-scanner-app --location=us
```

- [ ] **Step 2 (OWNER GATE - reads prod, writes bucket): Export at a snapshot time within the PITR window, scoped to tenant data**

```bash
# Snapshot time: pick "now minus 1 hour", whole minute, RFC3339 (PITR granularity). Verify it is
# after earliestVersionTime first:
gcloud firestore databases describe --database='(default)' \
  --project=smart-inventory-scanner-app --format="value(earliestVersionTime)"

gcloud firestore export gs://smart-inventory-scanner-app-drill-$(date +%Y%m%d)/export-1 \
  --database='(default)' --project=smart-inventory-scanner-app \
  --snapshot-time='<CHOSEN_RFC3339_TIME>' \
  --collection-ids='businesses,businessMembers,userProfiles,products,scanEvents,inventoryCounts,sessions,aliases,needsReview,pendingSync'
```

NOTE (to-verify, not gospel): `--collection-ids` matches collection-group IDs, which should include same-named subcollections at any depth - confirm against `gcloud firestore export --help` and current Firestore export docs before relying on it. Before running, list the real subcollection IDs under one business (`firestore_list_collections` MCP on `businesses/<known-bid>`) and use THAT list verbatim - the list above is indicative, the MCP read is truth. If the ID list is awkward, fall back to a full unfiltered export and accept ~12.5 min (proven to work).

Expected: operation completes; record doc count + elapsed time.

- [ ] **Step 3 (OWNER GATE - creates scratch DB): Create the scratch database with delete protection OFF**

```bash
# NO --delete-protection flag: absence = disabled, which is required so Task 4 cleanup can delete
# this scratch DB. (Passing the flag would ENABLE protection - it is a boolean enable flag.)
gcloud firestore databases create --database=drill-$(date +%Y%m%d) \
  --project=smart-inventory-scanner-app --location=nam5 \
  --type=firestore-native
```

Verify before proceeding: `gcloud firestore databases describe --database=drill-<date> --project=smart-inventory-scanner-app --format="value(deleteProtectionState)"` must print `DELETE_PROTECTION_DISABLED`.

- [ ] **Step 4 (OWNER GATE - the blocked step): Import into the scratch database**

```bash
gcloud firestore import gs://smart-inventory-scanner-app-drill-$(date +%Y%m%d)/export-1 \
  --database=drill-$(date +%Y%m%d) --project=smart-inventory-scanner-app
```

Expected: SUCCESS this time. If `PERMISSION_DENIED` again: (a) retry after 5 min (IAM propagation), (b) retry with a bucket that predates this session, (c) capture the full error + `gcloud logging read 'resource.type="datastore_database"' --limit=20 --project=smart-inventory-scanner-app` and STOP - record findings in RECOVERY.md; do not burn more than 3 attempts.

- [ ] **Step 5: Verify restored data (read-only, scratch DB)** - spot-check a known business (e.g. one of the canelo prod driver businesses recorded in memory: `default_b4bf...`, or any business the owner names):

Via Firebase MCP: `firestore_query_collection` against database `drill-YYYYMMDD`, collection `businesses/<bid>/products` and `businesses/<bid>/inventoryCounts` - confirm docs exist and `sum(countedQuantity)` is plausible for the snapshot time. Record 3 concrete document IDs + counts in RECOVERY.md as the evidence of record.

---

### Task 3: Create a weekly scheduled backup (OWNER GATE - recurring cost)

**Files:**
- Modify: `docs/RECOVERY.md` Section 2 (backup posture)

**Interfaces:**
- Produces: a weekly backup schedule making `gcloud firestore databases restore --source-backup` available for all future drills/recoveries (the only restore mode the installed CLI supports; today the project has ZERO backups and no schedule).

- [ ] **Step 0 (read-only, REQUIRED): Verify the exact flag names in the installed SDK** - review caught that `--day-of-week` is not a real flag; weekly cadence is expressed via `--recurrence=weekly` + `--weekly-recurrence=<DAY>` in current SDKs. Do not present the create command to the owner until this has been run:

```bash
gcloud firestore backups schedules create --help
```

- [ ] **Step 1 (OWNER GATE): Create the schedule** (flags below are the expected shape; correct them to whatever Step 0 printed before asking the owner)

```bash
gcloud firestore backups schedules create \
  --database='(default)' --project=smart-inventory-scanner-app \
  --recurrence=weekly --retention=4w --weekly-recurrence=SUNDAY
```

Cost note (cost-truth rule): backup storage bills per GiB-month at the Firestore backup rate; with ~4.16M docs the DB is single-digit GiB, so expect small-dollar monthly cost, but confirm the first real number in the billing console after the first backup lands - do not quote a figure before that.

- [ ] **Step 2 (read-only): Verify**

```bash
gcloud firestore backups schedules list --database='(default)' --project=smart-inventory-scanner-app
```

- [ ] **Step 3: Document in RECOVERY.md Section 2** - schedule exists, next-run expectation, and the simpler future drill path: `gcloud firestore backups list` -> `gcloud firestore databases restore --source-backup=<name> --destination-database=drill-<date>`.

---

### Task 4: Cleanup + close F-08 (OWNER GATE for deletions)

**Files:**
- Modify: `docs/RECOVERY.md` (Sections 3 + 5), `REPO_HEALTH.md:126-127`, `PROGRESS.md`

- [ ] **Step 1 (OWNER GATE): Delete scratch resources** (mirror the proven 2026-07-29 cleanup)

```bash
gcloud storage rm -r gs://smart-inventory-scanner-app-drill-<date>
# scratch DB via Firebase MCP firestore_delete_database (confirmed working last drill), then verify:
gcloud firestore databases list --project=smart-inventory-scanner-app
```

Expected: only `(default)` remains. If the owner wanted the Task 1 IAM grant removed, run the `remove-iam-policy-binding` rollback now.

- [ ] **Step 2: Close the finding in docs**
  - `RECOVERY.md` Section 5: F-08 -> CLOSED with date, elapsed times (export, import), the 3 spot-check document IDs, and the diagnosis one-liner from Task 1.
  - `RECOVERY.md` Section 3: replace the stale `--source-database/--snapshot-time` restore example (lines ~139-163) with the two REAL paths: export-at-snapshot->import (proven) and `--source-backup` (now available via the Task 3 schedule).
  - `REPO_HEALTH.md` ~126-127: replace "backup/recovery readiness is unverified" with the verified state + date.
  - `PROGRESS.md`: dated checkpoint.

- [ ] **Step 3: Commit (docs only)**

```bash
git add docs/RECOVERY.md REPO_HEALTH.md PROGRESS.md
git commit -m "docs(F-08): restore drill proven end to end; weekly backup schedule live; runbook corrected"
```

---

## Risks / notes

- If Step 2.4 fails again after the IAM grant + pre-existing-bucket retry, the fallback diagnosis path is `gcloud logging read` on the datastore admin activity log - the denial reason is logged server-side with the exact missing permission name. That single string is the whole remaining mystery.
- The drill restores tenant + shared-corpus data into a scratch DB in the SAME project; no data leaves the project. No customer-facing impact at any point.
- Cadence after closure: repeat the drill quarterly (RECOVERY.md already says "periodically"); with the Task 3 schedule the future drill is two commands.
