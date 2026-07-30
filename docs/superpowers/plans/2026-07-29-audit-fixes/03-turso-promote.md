# Agent 3 — Turso Promotion Tooling

> Read `00-orchestration.md` and master plan Tasks 6 & 14 first. Implement those steps verbatim.

**Sub-branch:** `audit-fixes/03-turso-promote`.

**Scope:** master-plan **Task 6 (F-05)** — cover all 5 swapped tables + replace the `unicode()`-blind
content fingerprint with a **PK-ordered streaming SHA-256 computed in JS** (SQLite/Turso has no hash builtin,
so this CANNOT be another SQL aggregate — reuse `cmdBackup`'s existing keyset row pass, `hash.update()` per
row, `digest("hex")` per table, one digest per table in the manifest); **Task 14 (F-17)** — rollback runbook
+ operator write-freeze note.

**Files you OWN:**
- `scripts/tire-db-repair/10_promote_execute.mjs`
- `scripts/tire-db-repair/10_promote_execute.test.mjs`
- a NEW runbook doc under `scripts/tire-db-repair/` or `docs/` (do NOT edit `docs/DEPLOY_TRUTH.md` —
  that is Agent 6's file)

**Internal order: SEQUENTIAL.** F-05 (fingerprint/coverage code) and F-17 (rollback path) both edit
`10_promote_execute.mjs`. Land F-05 (test green + committed) before F-17.

**Executor sequence:**
- Author the F-05 failing tests against a local `file:` libsql DB (harness uses
  `PROMOTE_TURSO_URL`) covering BOTH promotion scenarios — subsequent (all 5 tables present: same-length-edit
  digest change + drift on a newer table caught) AND first (the 3 newer tables ABSENT: reuse `seedFakeLiveDb()`,
  assert the `"ABSENT"` sentinel and NO `no such table` throw). Every extended per-table read must gate on the
  `sqlite_master` existence check before querying. Encode fingerprint fields with explicit type tags and
  UTF-8 byte lengths; delimiter-only serialization is forbidden.
- Apply and prove the `10_promote_execute.mjs` fix.
- Draft the F-17 write-freeze runbook + recovery-from-`*_failed_promotion_<ts>` procedure against the final
  function/table names.

For any owner-approved live promotion, bind the verification manifest to the exact staged dataset and keep
the Task 14 operator write-freeze active through the final check-to-swap window. The code-only result does not
authorize or prove a live promotion safe while concurrent writers remain active.

**Owner-gated:** NO live/production re-promote. This agent produces code + tests + docs only. Any actual
promotion against live Turso is a separate owner-approved action.

**Proof gate:** `node --test scripts/tire-db-repair/10_promote_execute.test.mjs` (full file, green).

**Definition of done:** backup/count/fingerprint cover all 5 swapped tables; any equal-length mutable
edit is detected; rollback runbook complete; no live promote run. Merge into `audit-fixes`.
