# Test Branch + Turso + Open Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `test` branch deployed to a live Vercel preview URL, remove the login/shop-selection walls so anyone can use the app via URL, finish Turso setup so 4M retail products resolve without AI, and raise the daily AI cap to 500 for testing.

**Architecture:** The `test` branch pushes to GitHub and gets a Vercel preview URL automatically (no production deploy). AuthGuard defaults to open access without needing env vars. The scan page loads directly -- no login, no business selection. Turso is populated with 4M retail products via the existing import script. The daily AI cap is raised to 500 via env var on the test deployment.

**Tech Stack:** Next.js 16 (App Router), Vercel preview deployments, Turso (libSQL), `@libsql/client` (already installed)

## Global Constraints

- Do NOT push to `master` -- all work goes on the `test` branch
- Do NOT deploy to production without explicit owner approval
- Do NOT delete the login/business code -- just bypass it (reversible)
- Do NOT change any AI decode logic, resolver logic, or scan store behavior
- The `test` branch preview URL will be shared with the owner for approval before anything touches `master`

---

### Task 1: Create the `test` branch and verify Vercel preview deployment

**What this does:** Creates a `test` branch from the current `master`, pushes it, and confirms Vercel generates a live preview URL. This preview URL is the "testing URL" -- live on the internet but completely separate from production.

**Files:**
- No file changes. Git branch + push only.

**Interfaces:**
- Consumes: nothing
- Produces: a live Vercel preview URL (something like `inventory-git-test-djsanti88-sudos-projects.vercel.app`)

- [ ] **Step 1: Create the test branch from master**

```bash
git checkout -b test
```

- [ ] **Step 2: Push the branch to GitHub (triggers Vercel preview deploy)**

```bash
git push -u origin test
```

- [ ] **Step 3: Wait for Vercel to build, then find the preview URL**

The Vercel dashboard or the GitHub commit status will show the preview URL. It will look like:
`https://inventory-git-test-djsanti88-sudos-projects.vercel.app`

Verify it loads (it will currently show the login wall -- that's expected, we fix it in Task 2).

- [ ] **Step 4: Report the preview URL to the owner**

Share the exact URL. This is the testing URL going forward. Production (`inventory-lovat-six.vercel.app`) stays untouched.

---

### Task 2: Remove the login wall -- open access by default

**What this does:** Makes `AuthGuard` default to open access so visitors go straight to `/scan` without logging in. The login page and auth code stay in the codebase (reversible), but nothing gates access anymore. The `NEXT_PUBLIC_OPEN_ACCESS` flag that already exists in `AuthGuard.tsx` is flipped to default-on, and the root redirect goes straight to `/scan`.

**Files:**
- Modify: `src/components/AuthGuard.tsx` (change default to open)
- Modify: `src/app/page.tsx` (already redirects to `/scan` -- no change needed, just verify)
- Test: manual browser verification on the preview URL

**Interfaces:**
- Consumes: nothing
- Produces: open access -- any visitor hits the scan page directly

- [ ] **Step 1: Make AuthGuard default to open access**

In `src/components/AuthGuard.tsx`, change line 15 from:

```typescript
const OPEN_ACCESS = process.env.NEXT_PUBLIC_OPEN_ACCESS === "1";
```

to:

```typescript
// Open access by default until login is re-enabled. Set NEXT_PUBLIC_REQUIRE_LOGIN=1 to restore the login wall.
const OPEN_ACCESS = process.env.NEXT_PUBLIC_REQUIRE_LOGIN !== "1";
```

This inverts the logic: open by default, login only if explicitly enabled. No env var needed for the common case.

- [ ] **Step 2: Verify the root page redirects to /scan**

Read `src/app/page.tsx` -- it already does `redirect("/scan")`. No change needed.

- [ ] **Step 3: Commit**

```bash
git add src/components/AuthGuard.tsx
git commit -m "feat: open access by default — no login wall until NEXT_PUBLIC_REQUIRE_LOGIN=1"
```

---

### Task 3: Remove the business/shop selection requirement

**What this does:** The scan page currently works fine without a selected business (it uses `DEMO_BUSINESS_ID` from the mock path). The `/business` page exists as a route but nothing in the scan flow forces you there -- the redirect to `/business` only happens when Firebase backend mode is on AND no business is selected. Since the app runs in mock/local mode by default (no `NEXT_PUBLIC_FIREBASE_BACKEND=1`), this is already bypassed.

However, the Nav component may show a link to `/business`. We verify and ensure the scan flow works end-to-end without business selection.

**Files:**
- Modify: `src/components/Nav.tsx` (hide business link if it exists)
- Test: manual browser verification -- scan page loads, scanning works, no business prompt

**Interfaces:**
- Consumes: Task 2 (open access)
- Produces: clean scan flow with no business selection step

- [ ] **Step 1: Check Nav for business link**

Read `src/components/Nav.tsx` and check if there's a link to `/business`. If there is, hide it behind the same `NEXT_PUBLIC_REQUIRE_LOGIN` guard (only show when login is enabled).

- [ ] **Step 2: Verify scan page loads without business context**

The scan store defaults to `DEMO_BUSINESS_ID` and `businessContextReady: true` on the mock/local path (line 722-725 of `scanStore.ts`). This means scanning already works without selecting a business. Verify by loading the preview URL and attempting a scan.

- [ ] **Step 3: Commit if any changes were made**

```bash
git add src/components/Nav.tsx
git commit -m "feat: hide business selection — universal access, no shop picker"
```

---

### Task 4: Populate Turso with 4M retail products

**What this does:** Runs the existing `scripts/import-retail-turso.mjs` script to bulk-import 4M retail products from the local 247MB JSON file into the Turso database. The script, the Turso database URL, and the `@libsql/client` dependency are all already in place from the June 29 session. What's missing is: (a) confirming the Turso database exists and is accessible, (b) obtaining or confirming the auth token, and (c) actually running the import.

**Prerequisites (owner action required before this task):**
- The owner must have a Turso account and a database created. The URL from the import script suggests it already exists: `libsql://inventory-retail-djsanti88-sudo.aws-us-east-1.turso.io`
- The owner must provide or confirm the `TURSO_AUTH_TOKEN`. This is a secret -- never commit it.

**Files:**
- No code changes. The import script (`scripts/import-retail-turso.mjs`) and the lookup code (`src/server/retail-knowledge/retailKnowledgeIndex.ts`) are already built.
- The local source file exists: `src/server/retail-knowledge/retailKnowledge.generated.json` (247MB)

**Interfaces:**
- Consumes: Turso auth token (from owner), local JSON file (exists)
- Produces: 4M rows in the Turso `retail` table, queryable from the app

- [ ] **Step 1: Verify Turso database exists**

```bash
# Install Turso CLI if not present
# (owner may need to run: npm install -g turso OR brew install tursodatabase/tap/turso)
turso db list
```

If the database `inventory-retail` doesn't appear, create it:
```bash
turso db create inventory-retail --location aws-us-east-1
```

- [ ] **Step 2: Get the auth token**

```bash
turso db tokens create inventory-retail
```

Save the token -- it will be needed for the import AND as a Vercel env var.

- [ ] **Step 3: Run the bulk import**

```bash
TURSO_AUTH_TOKEN=<token-from-step-2> node --max-old-space-size=4096 scripts/import-retail-turso.mjs
```

Expected output: imports ~4M rows in batches of 200. Takes several minutes. The script logs progress every 100K rows and skips if >3M rows already exist.

- [ ] **Step 4: Verify the import**

```bash
TURSO_AUTH_TOKEN=<token> turso db shell inventory-retail "SELECT COUNT(*) FROM retail"
```

Expected: a number around 3.5-4M.

Quick product spot-check:
```bash
TURSO_AUTH_TOKEN=<token> turso db shell inventory-retail "SELECT * FROM retail WHERE barcode = '0049000006346' LIMIT 1"
```

Expected: Coca-Cola or similar recognizable product.

---

### Task 5: Wire Turso credentials into the Vercel test deployment

**What this does:** Adds the `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` env vars to the Vercel project so the `test` branch preview deployment can query Turso for retail products. Also sets `AI_LOOKUP_DAILY_LIMIT=500` for testing.

**Prerequisites:** Task 4 complete (Turso populated), auth token in hand.

**Files:**
- No code changes. Vercel dashboard or CLI env var configuration only.

**Interfaces:**
- Consumes: Turso URL + token (from Task 4)
- Produces: preview deployment resolves retail barcodes from Turso; daily AI cap is 500

- [ ] **Step 1: Set Vercel env vars for Preview deployments**

Using the Vercel dashboard (Project Settings > Environment Variables) or CLI:

```bash
# Only for Preview deployments (NOT production)
vercel env add TURSO_DATABASE_URL preview
# Enter: libsql://inventory-retail-djsanti88-sudo.aws-us-east-1.turso.io

vercel env add TURSO_AUTH_TOKEN preview
# Enter: <the token from Task 4 Step 2>

vercel env add AI_LOOKUP_DAILY_LIMIT preview
# Enter: 500
```

IMPORTANT: Set these for **Preview** environment only, not Production. This keeps the test deployment separate from production.

- [ ] **Step 2: Trigger a redeploy of the test branch**

Push an empty commit or re-push:
```bash
git commit --allow-empty -m "chore: trigger Vercel redeploy with Turso credentials"
git push origin test
```

- [ ] **Step 3: Verify retail lookup works on the preview URL**

Open the preview URL, scan a common retail barcode (e.g., Coca-Cola `049000006346`). It should resolve instantly from Turso -- no AI call, no "Needs Review."

- [ ] **Step 4: Verify the daily cap is 500**

Scan an unknown code (something not in any database). It should go through AI decode. Check the feed row -- it should NOT say "Daily AI lookup cap reached" until 500 lookups.

---

### Task 6: End-to-end verification on the preview URL

**What this does:** A manual smoke test checklist on the live preview URL to confirm everything works before the owner reviews.

**Files:** No code changes.

- [ ] **Step 1: Open the preview URL -- should land on /scan directly (no login)**
- [ ] **Step 2: Scan a known tire code -- should resolve from SQLite (76K tires)**
- [ ] **Step 3: Scan a common retail barcode (Coca-Cola, Nutella) -- should resolve from Turso (no AI call)**
- [ ] **Step 4: Scan a truly unknown code -- should trigger AI decode (Gemini first, then OpenAI fallback)**
- [ ] **Step 5: Verify no /login redirect, no /business selection screen**
- [ ] **Step 6: Report the preview URL and results to the owner for approval**

---

## Summary of what's missing for Turso (from the June 29 session)

The code is 100% done. What's missing is operations:

| What | Status | What's needed |
|---|---|---|
| `@libsql/client` npm package | Installed (v0.17.4) | Nothing |
| Import script (`scripts/import-retail-turso.mjs`) | Written and committed | Nothing |
| Lookup code (`retailKnowledgeIndex.ts`) | Written -- local SQLite first, Turso fallback | Nothing |
| Turso database | URL exists in the script (`inventory-retail-djsanti88-sudo`) | Verify it's accessible |
| Turso auth token | NOT stored anywhere (correct -- it's a secret) | Owner provides or generates |
| 4M row import | Never actually run | Run the import script (~5 min) |
| Vercel env vars | NOT set on Vercel | Add `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` to Preview env |
| Source JSON file | Exists locally (247MB) | Nothing |

In short: the pipe is built, the data is on disk, but nobody turned the faucet on.

---

## What stays on production (untouched)

- `inventory-lovat-six.vercel.app` keeps its current state (login wall, no Turso, 200 daily cap)
- `master` branch is not modified
- No env vars are changed on the Production environment
- Nothing is deployed to production until the owner explicitly approves
