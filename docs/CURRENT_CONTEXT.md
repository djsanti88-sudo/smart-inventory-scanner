# Current Context (Track 1 working memory)

_Last updated: 2026-06-15. Keep this current as facts change._

## 1. Branches
- `master` — base; has Firebase Phase 2 merged.
- `benchmark-tire-db-automation` — PR #3 (benchmark + tire-DB pipeline). Not merged.
- `hotfix-multicode-tire-resolution` — **PR #4** (multi-code resolution P1–P5). Open, not merged.
- `qa-human-bots` — off the hotfix branch; adds the QA bot harness, slash-normalization fix, the LIVE
  account repair + cloud regression bot, Products-page crash fix, clearLocalCache cloud-safe fix.
- `qa-agent-army-track1` — **THIS task**, off `qa-human-bots` (inherits all the above).

## 2. Already fixed (must preserve)
- Code normalization for separators: dash / no-dash / space / slash / backslash / underscore / dot
  (`src/services/scanCleaner.ts` `buildNormalizedCandidates` strips `[-\s/\\_.]+`; `src/services/codeNormalizer.ts`).
- Multi-code capture on product create (`scanStore.buildProductCodeAliases`).
- Human-mistake guard (`src/services/productMismatchGuard.ts`) + UI banner.
- Alias repair: `scanStore.unlinkAlias` / `moveAlias` + Products "Codes" panel.
- **Products page infinite-render crash fix** (selector returned a new array each render).
- **clearLocalCache cloud-safe** (no `FirebaseSyncTarget.reset()` in cloud mode) + Settings message/reload.
- **Live cloud account repaired**: alias `2881-6861` MOVED off Camel → Falken in cloud Firestore
  (business `biz-nDPz45mqDMaaucovnl4y5v5vhSH3`, alias `alias-33d57be0…`). Proven via `qa:bots:live`.
- Bot harness + scenarios: `e2e/human-bots/`, `playwright.bots.config.ts`, `playwright.bots.cloud.config.ts`,
  scripts `qa:bots*`, `qa:bots:live`, `qa:revision`. Revision gate: `docs/REVISION_GATE.md`, `docs/QA_BOTS.md`.

## 3. Still pending
- The DEFERRED platform/customer **role + data-protection foundation** (docs/HOTFIX_FOLLOWUPS.md):
  platformOwner vs customer roles, server-side customer resolution, role-aware serializers, customer
  code-hiding + sanitized exports, "AI" de-branding, global-vs-business alias scoping.
- **Role-based code hiding is NOT implemented** — so today every authenticated user can see codes. This
  is the key thing the SecurityLeakBot will report as a P0 gap (honest current state).

## 4. Which branch has the live account fix
`qa-human-bots` (and inherited by `qa-agent-army-track1`). The cloud DATA itself is fixed regardless of branch.

## 5. Which branch has the bot system
`qa-human-bots` → inherited here on `qa-agent-army-track1` (Track 1 extends it).

## 6. Fixes NOT yet in PR #4
PR #4 (`hotfix-multicode-tire-resolution`) does NOT contain: slash/backslash/underscore/dot normalization,
the Products-page crash fix, clearLocalCache cloud-safe fix, the bot harness, or the live regression bot.
Those live on `qa-human-bots` / `qa-agent-army-track1`. Folding into PR #4 or a follow-up PR is a later decision (no auto-merge).

## 7. Falken / Camel regression codes (all must NOT resolve to Camel)
`2881-6861`, `28816861`, `2881 6861`, `2881/6861`, `2881\6861`, `2881_6861`, `2881.6861`, `848983012906`.
All known Falken shapes should resolve to the Falken tire when it exists; ambiguous normalized → Needs Review.

## 8. Access model (platformOwner vs customer)
- **platformOwner / superAdmin / Santiago**: sees raw/clean/normalized codes, aliases, UPC/EAN/GTIN, raw QR,
  global catalog aliases, source evidence, provider/internal diagnostics; can export internal/debug; repairs global aliases.
- **businessOwner / shopOwner / admin**: scan/count/manage shop data + product-facing info ONLY; NO raw
  barcode/alias DB, NO global alias DB, NO provider/AI/prompt/decode-trace/source-evidence.
- **counter**: scan/count, product-facing only, no internal DB, no high-risk override.
- **viewer**: read-only product-facing only, no internal DB, no code-bearing exports.
- _Current reality:_ this model is the TARGET; client-side role gating is not built yet.

## 9. What Track 1 may change
QA/bot harness, bot scenarios/personas, helpers, reports, revision-gate docs, package scripts, and
low-risk obvious UX copy fixes. Safe (non-destructive) security checks only.

## 10. What Track 1 must NOT touch
No public deploy, no auto-merge, no destructive cloud writes, no secrets, `.env.local` stays untracked,
no service-account JSON, no Marketing/Competition bots, no Firecrawl competitor research (Track 2 later).

---

# P0 Security Audit (audit-first) — context

1. **Tire/Falken/Camel live cloud issue: FIXED** — alias 2881-6861 moved off Camel → Falken on the real god account; proven by `qa:bots:live`.
2. **Separator normalization exists** for dash, no-dash, space, slash, backslash, underscore, dot (`scanCleaner.buildNormalizedCandidates`).
3. **Clear local cache cloud-mode crash: FIXED** (no `FirebaseSyncTarget.reset()` in cloud mode).
4. **Products page infinite-render bug: FIXED** (stable aliases selector).
5. **Human/live bot system exists** (`qa:bots:*`, `qa:bots:live`, revision gate).
6. **P0 security risk (confirmed by this audit):** customer browsers download the full alias table + product
   code fields (and the global `catalogEntries` collection is readable by any signed-in user); persisted to
   localStorage; exportable; visible in UI — with NO platformOwner concept and NO role gating.
7. **Track 2 recommends** the customer-safe foundation as the next milestone (this audit is its prerequisite).
8. **PR #4** does NOT include the later fixes (normalization beyond slash, Products/clearLocalCache fixes, bots) — those are on qa-human-bots/qa-agent-army-track1; this audit branch is off qa-agent-army-track1.
9. **This task is the P0 data-protection AUDIT + execution plan only.** Audit reports written:
   `reports/platform-security/{preflight,data_flow_audit,PLATFORM_CUSTOMER_SECURITY_AUDIT_REPORT}.md`.
   **Implementation (Phases 2–9) is NOT started — awaiting Santiago "Approved".**
