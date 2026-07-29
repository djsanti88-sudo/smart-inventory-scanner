# Agent 5 — Firestore Rules / Indexes / Recovery

> Read `00-orchestration.md` and master plan Tasks 2 & 8 first. Implement those steps verbatim.

**Sub-branch:** `audit-fixes/05-firestore-infra`.

**Scope:** master-plan **Task 2 (F-01 + F-07)** — prove the already-hardened tracked rules + all 3 indexes
under the emulator and PREPARE the production deploy; **Task 8 (F-08)** — PITR / delete-protection runbook.

**Files you OWN:**
- `firestore.rules` (edit ONLY if the emulator suite fails — the tracked source is believed already
  hardened; the production gap is a DEPLOY gap, not a source gap)
- Existing Firebase rules tests under `src/services/db/firebase/**`, EXCEPT Agent 1's NEW
  `markWrongTransfer.rules.test.ts`; edit only when a failing emulator proof shows the existing expectation
  is wrong or incomplete
- `firestore.indexes.json`, `firebase.json`, `.firebaserc` (reference)
- a NEW recovery doc (e.g. `docs/RECOVERY.md`) for the PITR runbook (do NOT edit `docs/DEPLOY_TRUTH.md` —
  Agent 6 owns it)

**Owner-gated (prepare, do NOT run):** `firebase deploy --only firestore:rules --project prod`,
`firebase deploy --only firestore:indexes --project prod`, and enabling PITR/delete-protection (billing
impact). Write the exact commands + post-deploy verification steps for the owner.

**Internal order:** emulator proof, index check, and the PITR doc are independent and may be sequenced in
either order.

**Executor sequence:** run `npm run test:firebase` and report rule/index parity; draft the
PITR/delete-protection + restore-drill runbook; assemble the owner deploy command sheet.

**Port note:** `test:firebase` uses the Firestore emulator (8080/9099). Per `00-orchestration.md`, do not
run it concurrently with Agents 1/2's emulator runs — the orchestrator serializes emulator usage.

**Proof gate:** `npm run test:firebase` green; deploy command sheet + recovery runbook complete.

**Definition of done:** tracked rules/indexes proven under emulator; exact prod-deploy + PITR steps
prepared for the owner; nothing deployed. Merge into `audit-fixes`.
