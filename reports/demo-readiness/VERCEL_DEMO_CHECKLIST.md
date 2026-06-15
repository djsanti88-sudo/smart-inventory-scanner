# Vercel Demo Readiness Checklist (Window 2)

**Branch:** `demo-readiness-vercel-partnumber` (base `7090873` on `p0-platform-customer-security-audit`)
**Status:** Preparation only. **NO DEPLOY** unless Santiago explicitly types `DEPLOY NOW`.

> ⚠️ **Credential warning:** Without Firebase Admin credentials in the Vercel runtime, `/api/resolve-scan`
> returns `503 { reason: "server_resolution_unavailable" }` for customer scans in the real cloud. The
> client falls back gracefully (no crash), but **customer server-side scan resolution will not work in
> production until Admin credentials are configured.** platformOwner and the mock/demo path are unaffected.

---

## 1. Required Vercel environment variables

### 1a. Firebase public client config (`NEXT_PUBLIC_*`, safe to expose — they ship in the browser bundle)
Source of truth: [src/lib/firebaseClient.ts](../../src/lib/firebaseClient.ts).

| Variable | Notes |
|----------|-------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase Web API key (public by design). |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | e.g. `smart-inventory-xxxx.firebaseapp.com`. |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Real Firebase project id. |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | e.g. `…appspot.com`. |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | From Firebase console. |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | From Firebase console. |
| `NEXT_PUBLIC_FIREBASE_BACKEND` | Set `=1` to use the **real Firebase** backend (otherwise the app runs the in-memory mock). For a real-cloud demo this must be `1`. |
| `NEXT_PUBLIC_FIREBASE_USE_EMULATOR` | Leave **unset / `0`** for cloud. `=1` only points the client at a local emulator. |

> Do **NOT** set `NEXT_PUBLIC_E2E_AUTH_BYPASS` or `NEXT_PUBLIC_E2E_PLATFORM_OWNER` in the Vercel
> environment — those are test-only overrides that would bypass auth / force platformOwner. They must be
> **absent** in any deployed environment.

### 1b. Platform-owner allowlist (Santiago identity)
Source of truth: [src/services/security/roleAccess.ts](../../src/services/security/roleAccess.ts).

| Variable | Required? | Value |
|----------|-----------|-------|
| `PLATFORM_OWNER_EMAILS` | **Yes** (server, authoritative) | `djsanti88@gmail.com` |
| `NEXT_PUBLIC_PLATFORM_OWNER_EMAILS` | **Yes** (client UI gate only) | `djsanti88@gmail.com` |
| `PLATFORM_OWNER_UIDS` | Optional — **only if the UID is verified** | the real Firebase Auth UID for the owner account (leave blank until verified in Firebase console → Authentication → Users). Email match alone is sufficient. |
| `NEXT_PUBLIC_PLATFORM_OWNER_UIDS` | Optional, same caveat | same UID, only if verified. |

- Email match OR UID match grants `platform`. Server env is authoritative for data; `NEXT_PUBLIC_*`
  only gates UI. Keep the email lists identical so UI and server agree.
- **Do not** add any other email here. A business "owner"/"admin" role must never be platformOwner.

### 1c. Firebase Admin (server-side, secret — see §2). Optional AI keys (§1d) stay **off** for the demo.

### 1d. AI / external keys (leave OFF for a controlled demo)
`GEMINI_API_KEY`, `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `ENABLE_LIVE_AI_LOOKUP`, `ENABLE_AUTO_DECODE_ON_SCAN`,
etc. — **leave unset** so the demo never spends tokens and unknown codes deterministically route to Needs
Review. (These are server-only and already excluded from the client bundle.)

---

## 2. Firebase Admin credential strategy for Vercel (the real blocker)

The Admin SDK ([src/lib/firebaseAdmin.ts](../../src/lib/firebaseAdmin.ts)) initializes credentials in this order:
1. **Emulator** (`FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` set) → no creds. *Not for prod.*
2. **`FIREBASE_SERVICE_ACCOUNT_PATH`** → reads a service-account **JSON file at that path**.
3. **`GOOGLE_APPLICATION_CREDENTIALS`** (ADC) → path to a credentials file, or workload identity.

**Problem on Vercel:** serverless functions have no committed secret file and only `/tmp` is writable at
runtime. The current code accepts a **file path**, not raw JSON-in-an-env-var.

### Recommended safe options (pick one, ops decision)
- **Option A — small ops code addition (recommended, but OUT OF THIS WINDOW'S SCOPE):** add support for a
  `FIREBASE_SERVICE_ACCOUNT_JSON` secret env var that is parsed directly (or written to `/tmp` at boot and
  pointed to by `GOOGLE_APPLICATION_CREDENTIALS`). This touches **server credential logic** and so must be
  done/approved by Window 1 / Santiago, then SecurityLeakBot re-run. Flagged, not implemented here.
- **Option B — defer real-cloud customer resolution:** run the controlled demo with `platformOwner`
  (Santiago) for scanning, and show the customer view as read-only. Customer scans then rely on the
  graceful `503` fallback. No Admin creds needed for the demo to be safe and presentable.

### Safe storage rules (whichever option)
- Store the service-account secret as a **Vercel Environment Variable / Secret**, marked for the correct
  environment (Preview/Production), **never** committed to git.
- **Never** commit the service-account JSON. Confirm it is `.gitignore`d. **Never** inline it in code.
- Scope it to the demo Firebase project only. Rotate after the demo if it was widely shared.

---

## 3. Firebase Auth authorized domain

- In **Firebase Console → Authentication → Settings → Authorized domains**, add the exact Vercel domain
  (e.g. `your-demo.vercel.app` and any custom domain). Without this, Google/email sign-in fails on the
  deployed URL with an `auth/unauthorized-domain` error.
- Add both the **preview** URL and the **production** URL if both will be used.

---

## 4. Demo account requirements

- **platformOwner:** the `djsanti88@gmail.com` account (must match `PLATFORM_OWNER_EMAILS`).
- **Customer demo account:** a separate, non-owner account that is a **member of one demo business** with
  seeded demo products only. This account must NOT be on any platform-owner allowlist.
- Pre-seed a small, fake demo catalog (no real customer data).

---

## 5. Hard rules for the demo environment

- **No public signup.** Disable open sign-up; create demo accounts manually (Firebase console) or keep the
  app invite/seed-only. Verify there is no self-serve "create account" path reachable on the demo URL.
- **Controlled demo URL only.** Share the preview/demo URL privately with Santiago; do not publicize.
- **No real customer data.** Seed fake products/businesses only. Never import a real customer's catalog.
- **No deploy** until Santiago types `DEPLOY NOW`. **No merge.** Vercel cron / GitHub Actions: not added.

---

## 6. Post-deploy smoke test checklist (run only AFTER an approved deploy)

1. App loads at the Vercel URL with no console errors.
2. platformOwner (`djsanti88@gmail.com`) can log in → sees full view (raw code columns, AI/provider status).
3. Customer demo account logs in → **cannot** see barcode/raw-code/alias/GTIN/UPC/EAN columns anywhere.
4. Customer sees **Part number** in: Live Scan Feed, Final Count table, Products table.
5. Scan a known seeded product → counts; product name + part number visible to the customer.
6. Scan an unknown code → routes to **Needs Review** (no crash, no token spend).
7. Customer export (Final counts CSV) → contains `part_number`, **no** barcode/gtin/upc/ean/aliases.
8. `/api/resolve-scan` as a customer → either sanitized result **or** graceful `503
   server_resolution_unavailable` (if Admin creds not configured) — never a 500 crash, never raw codes.
9. SecurityLeakBot proof still shows **P0:0 / P1:0 / P2:0** against the deployed behavior model.

---

## 7. Rollback plan

- Vercel: use **Instant Rollback** to the previous good deployment (Deployments → previous → "Promote to
  Production"), or `vercel rollback`. Rollback is config/deploy-level; no code change required.
- Because this is a **preview/demo**, the safest rollback is simply to **not promote to production** and to
  unshare the preview URL.
- Git: the demo branch is unmerged; reverting is a no-op on `main`. Nothing to revert in the product line.
- If a credential was exposed: **rotate the Firebase service account immediately** and remove the Vercel secret.

---

## 8. Santiago's final-hour review checklist

- [ ] `PLATFORM_OWNER_EMAILS` + `NEXT_PUBLIC_PLATFORM_OWNER_EMAILS` = `djsanti88@gmail.com` (and nothing else).
- [ ] No `NEXT_PUBLIC_E2E_*` bypass vars set in the Vercel environment.
- [ ] Decide Admin-credential path: **Option A** (ops code addition) or **Option B** (platformOwner-driven demo).
- [ ] Vercel domain added to Firebase **Authorized domains**.
- [ ] Public signup disabled; demo accounts created; demo catalog seeded with **fake** data only.
- [ ] Run the §6 smoke list mentally / on a preview before any production promotion.
- [ ] Confirm SecurityLeakBot proof summary (P0:0/P1:0/P2:0) from Window 1.
- [ ] **No deploy unless you type `DEPLOY NOW`.**
