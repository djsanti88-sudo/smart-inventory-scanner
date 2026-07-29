# Firestore Recovery Runbook (F-08, F-01, F-07)

Status: **OWNER-GATED / OPEN.** Nothing in this document has been run against production. This is the
prepared runbook the owner executes; agents and automation must never run the mutating commands below
without the owner's explicit in-the-moment approval (see `CLAUDE.md` "No-Deploy Rule").

## 1. Current production state (verified live, read-only, 2026-07-29)

Read directly from the live `(default)` database in project `smart-inventory-scanner-app` via the
Firebase MCP `firestore_get_database` call (no write performed):

| Setting | Live value |
|---|---|
| `pointInTimeRecoveryEnablement` | `POINT_IN_TIME_RECOVERY_DISABLED` |
| `deleteProtectionState` | `DELETE_PROTECTION_DISABLED` |
| `versionRetentionPeriod` | `3600s` (1 hour default change history) |
| `freeTier` | `true` |
| `databaseEdition` | `STANDARD` |
| `locationId` | `nam5` |

Plain language: today, a mistaken `gcloud firestore databases delete`, a bad migration, or a bug that
mass-deletes/corrupts documents has **no way back beyond the last hour** of change history, and the
database itself can be deleted with no confirmation gate. This is the F-08 finding.

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

- **F-08** (PITR / delete protection): stays **OPEN / OWNER-GATED** until the owner completes Section 2
  and records a passing restore drill (Section 3) here.
- **F-01 / F-07** (hardened rules + missing indexes deployed): stays **OPEN / OWNER-GATED** until the
  owner runs Section 4's deploy commands and the post-deploy verification in Section 4 passes.

No agent may mark either finding CODE-CLOSED. Only the owner completing the live action, followed by the
integrator confirming the post-deploy verification, closes them.
