# npm audit triage — 2026-07-29

Agent E2, read-only. Source: `npm audit --json` run on branch `audit-fixes`, then
`npm audit fix --dry-run --json` to see exactly what a non-breaking `npm audit fix`
would touch (no install/lock changes were made). **Current count is 16 advisories
(1 low / 8 moderate / 7 high)**, not the 13 (1/8/4) quoted in the task — the audit
data has moved since that number was captured; treat this report's 16 as current
truth.

## Table

| Package | Sev | Vuln class | Prod-reachable? | `npm audit fix` (no --force) resolves it? | Real exploitability here |
|---|---|---|---|---|---|
| **next** (direct) | High | Middleware/proxy bypass, Server Action SSRF, DoS, cache confusion, endpoint disclosure (7 CVEs, Next <16.2.11) | **YES — this is the running app/API** | No. Fix exists (16.2.9→16.2.12, **non-major**) but `package.json` pins `"next": "16.2.9"` exactly, so audit-fix's own dry run silently skips it | **Highest real risk in this list.** Server Action SSRF + auth-bypass CVEs are directly network-facing on a Next 16 App Router app. Needs an explicit `npm install next@16.2.12` (patch only, not a major bump) |
| **sharp** (transitive, via next) | High | libvips CVEs (2026-33327/28, 35590/91) | Yes, via `next/image` optimization if used | No — bundled by next, fixed only when next bumps | Real if the app serves `next/image` optimized images from remote/user sources; moderate priority, rides along with the next bump |
| **postcss** (transitive, via next + tailwindcss) | High | XSS in stringify, arbitrary file read / path traversal via sourceMappingURL | No — build-time only, processes only this repo's own CSS source, never a request body | **Yes** — dry run bumps postcss 8.5.15→8.5.25, past all three vulnerable ranges | Near-zero. No attacker-controlled CSS ever reaches postcss in this app |
| **@tailwindcss/postcss** (direct, dev) | High | Same postcss chain | No — dev/build tool | **Yes** — bumped to 4.3.3 alongside tailwindcss/oxide/node packages | Near-zero, build-time only |
| **brace-expansion** (transitive ×4 copies) | High | ReDoS / OOM via glob `{}` expansion | Mixed: 2 copies are dev-only (eslint, typescript-eslint); 2 sit under prod deps (exceljs→archiver→readdir-glob; firebase-admin→google-gax→rimraf/glob) | **Yes** — all 4 copies bumped past vulnerable ranges | Near-zero even on the "prod" copies — no user input is ever fed into these glob calls (archiver builds xlsx zips from fixed internal paths; rimraf/glob is google-gax's own tooling, not invoked per-request) |
| **js-yaml** (transitive, via eslint) | High | Quadratic CPU via YAML merge-key chains | No — ESLint config parsing only, dev-time | **Yes** — bumped 4.2.0→4.3.0 | None — never runs in the shipped app |
| **undici** (transitive, via jsdom) | High | TLS bypass, header injection, WS DoS, cache poisoning, SameSite downgrade (6 CVEs) | **No — jsdom is a devDependency used only by the Vitest `dom` project**; not bundled into the running app | **Yes** — bumped 7.27.2→7.29.0 | None — test-runner-only dependency |
| **protobufjs** (transitive, via firebase-admin/google-gax) | Moderate | DoS via infinite loop in `.proto` option parsing | Yes, technically in the firebase-admin/Firestore prod path | **Yes** — firebase-admin bump to 14.2.0 carries protobufjs to 7.6.5 | Low — `.proto` definitions are the SDK's own static files, not user input |
| **firebase-admin** (direct) | Moderate | Pulls in vulnerable `@google-cloud/storage` chain | Partially — Firestore/Auth are actively used (per CLAUDE.md); grepped `src/` for `admin.storage()` / `getStorage()` / `.bucket(` — **zero matches**, so the vulnerable Storage code path is never invoked even though it's in the dependency tree | Partial — fix bumps it to 14.2.0 (fixes protobufjs) but npm's suggested full fix for the storage advisory is a **downgrade to firebase-admin 10.3.0** (`isSemVerMajor: true`), which is not a safe automatic action | Low in practice (Storage APIs unused), but the suggested "fix" is a downgrade — needs a human decision, not `--force` |
| **@google-cloud/storage** / **retry-request** / **teeny-request** / **gaxios** (transitive, via firebase-admin) | Moderate | Retry/request-handling bugs (via `uuid` chain) | In the prod dependency tree, but functionally unreached (no Storage bucket calls found in `src/`) | No — only resolves via the firebase-admin major-downgrade path above | Very low — dead code path in this app today |
| **exceljs** (direct) | Moderate | `uuid` missing buffer-bounds check (v3/v5/v6 when caller supplies a buffer) | **Yes** — used in `src/services/universalFileReader.ts` (parses user-uploaded Excel/CSV files — untrusted input) and `src/services/exportFormats.ts` | No — fix is a **downgrade to exceljs 3.4.0** (major, older release) | The specific CVE (manual buffer-bounds bypass) isn't obviously triggered by parsing an uploaded xlsx, but exceljs sits directly on an **untrusted-file-upload path**, so this is the one "moderate" worth a deliberate look (upgrade path, not the suggested downgrade) rather than blanket accept |
| **uuid** (transitive, via exceljs/gaxios/teeny-request) | Moderate | Same buffer-bounds issue as above | Mixed — one copy under exceljs (see above), one under the unreached storage chain | No — only via exceljs's major downgrade | Same reasoning as exceljs entry |
| **dompurify** (transitive, via jspdf, direct prod dep) | Low | `CUSTOM_ELEMENT_HANDLING` bypasses `afterSanitizeElements` for allowed custom elements | Yes — jspdf is a direct prod dependency (client-side PDF export) | **Yes** — bumped 3.4.11→3.4.12 | Low — app doesn't appear to sanitize custom elements via dompurify directly (it's jspdf's internal use); fixed for free anyway |

## Recommended action list

**Safe: `npm audit fix` now (owner-gated, one command, no `--force`, no majors)**
Resolves 8 of the 12 advisory groups: postcss, @tailwindcss/postcss (+tailwindcss/oxide/node),
brace-expansion (all 4 copies), js-yaml, undici, protobufjs, firebase-admin→14.2.0 (partial —
only clears the protobufjs piece), dompurify. Confirmed via dry run; touches `package.json`/
`package-lock.json` only for minor/patch bumps, zero major-version changes.

**Needs planned upgrade (deliberate, not blanket `--force`)**
1. **`next` 16.2.9 → 16.2.12** — non-major but blocked by exact version pin in `package.json`.
   Highest-priority item: fixes 7 real network-facing CVEs (SSRF, auth/middleware bypass, DoS)
   in the actual running app. Do this first, separately from the bulk `audit fix`, and rerun
   `npm run build` + `npm run test:e2e` after.
2. **`sharp`** — rides along automatically once `next` is bumped (bundled by next).
3. **`exceljs`** — npm's suggested "fix" is a downgrade to 3.4.0; do not take it. Check for a
   current exceljs major that carries a patched `uuid` forward instead, since this package sits
   on the untrusted-file-import path.
4. **`firebase-admin` full storage-chain fix** (`@google-cloud/storage`/`retry-request`/
   `teeny-request`/`gaxios`) — same "don't take the suggested downgrade" caveat; low urgency
   since the Storage API is unused in `src/`.

**Accept/ignore for now (dev-only or unreached, but will be fixed for free by the `audit fix` above anyway)**
undici (test-only via jsdom), js-yaml (lint-only), postcss/@tailwindcss postcss (build-time only),
brace-expansion (no user-input-driven glob calls in this app), protobufjs (static `.proto` files
only), the unused `@google-cloud/storage` chain (dead code path).

## Counts

- Safe now via plain `npm audit fix`: **8** advisory groups (postcss, @tailwindcss/postcss,
  brace-expansion, js-yaml, undici, protobufjs, dompurify, firebase-admin-partial)
- Needs planned/deliberate upgrade: **4** (next, sharp, exceljs, firebase-admin storage chain)
- Accept/ignore (dev-only or functionally unreached): **6** of the above overlap with the
  "safe now" bucket already, plus the unused storage chain — no separate action needed beyond
  the two buckets above.

## Single most urgent item

**`next` 16.2.9 → 16.2.12.** It's the direct, production-facing framework dependency with 7
real CVEs including Server Action SSRF and a middleware/auth bypass — the only item in this
list with genuine network-facing exploitability in the live app. The fix is a non-major patch
bump; it's just blocked by the exact-pin in `package.json` so `npm audit fix` skips it silently.
Recommend an explicit, isolated `npm install next@16.2.12` (owner-gated) followed by full
proof (`npm run build`, `npm run test:e2e`, `npm run qa:revision`) before anything else in this
list.
