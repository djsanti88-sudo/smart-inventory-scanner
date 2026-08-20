# Production cleanup plan — legacy poisoned Manstel / 745125495781 (NOT EXECUTED)

> Status: **DRAFT — awaiting explicit owner approval. Nothing in here has been run against production.**
> No production write has been performed by this task. This plan is the owner-gated, dry-run-first
> procedure to remove the legacy poisoned rows that earlier (pre-fix) dev sessions wrote to the real
> Firestore project `smart-inventory-scanner-app`.

## What we are removing and why
Earlier dev sessions ran `npm run dev` wired to production Firestore (now fixed — `dev` defaults to mock).
Those sessions auto-counted the non-tire barcode **745125495781** as a "Manstel … Aluminum … Rivet … Kit"
(qty ~7 + a qty-1 row observed in the live cloud Products view). These must be removed from production:
- `products` whose identity is the poison code **745125495781** (primaryBarcode/upc/gtin/ean/aliases) AND
  whose name matches `/manstel|rivet/i`.
- their `aliases` (cleanCode/normalizedCode == 745125495781).
- their `inventoryCounts` rows.
- any `catalog` / `shopOverride` entry keyed to normalizedBarcode 745125495781.

Scope guard: **only** docs that match BOTH the poison code AND a rivet/Manstel name are eligible. Real tire
products are never touched. Seed/manual products are never touched.

## Safeguards (hard requirements before any write)
1. **Dry-run first, always.** The script prints every doc it WOULD delete and writes a JSON backup file.
   No write happens without `--apply`.
2. **Backup before delete.** `--apply` first writes `prod-poison-backup-<timestamp>.json` (full doc data) so
   the deletion is reversible by re-import.
3. **Typed confirmation.** `--apply` also requires `--yes-write-to-production` AND an interactive typed
   phrase, so it cannot run by accident or in CI.
4. **Owner credentials only.** Uses a service-account key the OWNER supplies via
   `GOOGLE_APPLICATION_CREDENTIALS`. This repo never commits or reads production secrets; the client app
   never imports the Admin SDK (`firebaseClient.ts` is public-config only).
5. **Soft-delete option.** Prefer `--soft` (set `status:'archived', verified:false`, aliases
   `approved:false`) over hard delete, mirroring the in-app reversible `deleteProduct`. Hard delete only on
   explicit `--hard`.

## Procedure (owner runs, after approval)
```bash
# 0. Install the admin SDK locally (owner machine only; not added to the app bundle)
npm i -D firebase-admin

# 1. Point at the OWNER's service account (never committed)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
export FIREBASE_PROJECT_ID=smart-inventory-scanner-app

# 2. DRY RUN — read-only. Lists matches + writes a backup JSON. NO writes.
node scripts/prod-cleanup-poison.mjs            # dry run (default)

# 3. Review the printed matches + the backup file. If correct:
node scripts/prod-cleanup-poison.mjs --apply --soft --yes-write-to-production
#    (then type the confirmation phrase when prompted)

# 4. Verify in the app (npm run dev:prod, knowingly) that the Manstel rows are gone.
#    Rollback if needed: re-import the backup JSON.
```

## Embedded script (to be added as `scripts/prod-cleanup-poison.mjs` only when approved)
```js
// NOT WIRED INTO package.json. Owner-run, dry-run-first. Requires firebase-admin + a service account.
import admin from "firebase-admin";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const POISON = "745125495781";
const NAME_RE = /manstel|rivet/i;
const APPLY = process.argv.includes("--apply");
const HARD = process.argv.includes("--hard");
const CONFIRMED = process.argv.includes("--yes-write-to-production");

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
const db = admin.firestore();

const isPoison = (d) => [d.primaryBarcode, d.upc, d.gtin, d.ean, ...(d.aliases ?? [])].includes(POISON) && NAME_RE.test(`${d.name ?? ""} ${d.brand ?? ""}`);

// Read-only scan across the businesses' collections (adjust paths to the real schema before running).
const matches = { products: [], aliases: [], counts: [] };
const products = await db.collectionGroup("products").get();
products.forEach((doc) => { const d = doc.data(); if (d.source !== "seed" && d.source !== "manual" && isPoison(d)) matches.products.push({ ref: doc.ref.path, data: d }); });
const aliases = await db.collectionGroup("aliases").where("cleanCode", "==", POISON).get();
aliases.forEach((doc) => matches.aliases.push({ ref: doc.ref.path, data: doc.data() }));
const counts = await db.collectionGroup("inventoryCounts").get();
counts.forEach((doc) => { const d = doc.data(); if (matches.products.some((p) => p.data && d.productId && p.ref.endsWith(d.productId))) matches.counts.push({ ref: doc.ref.path, data: d }); });

console.log(`[dry-run=${!APPLY}] poison products:${matches.products.length} aliases:${matches.aliases.length} counts:${matches.counts.length}`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`prod-poison-backup-${stamp}.json`, JSON.stringify(matches, null, 2));
console.log(`Backup written: prod-poison-backup-${stamp}.json`);

if (!APPLY) { console.log("DRY RUN ONLY. Re-run with --apply --yes-write-to-production to act."); process.exit(0); }
if (!CONFIRMED) { console.error("Refusing: --apply requires --yes-write-to-production."); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const phrase = await rl.question('Type EXACTLY "delete poison from production" to proceed: ');
rl.close();
if (phrase.trim() !== "delete poison from production") { console.error("Phrase mismatch. Aborted."); process.exit(1); }

const all = [...matches.products, ...matches.aliases, ...matches.counts];
for (const m of all) {
  const ref = db.doc(m.ref);
  if (HARD) await ref.delete();
  else if (m.ref.includes("/products/")) await ref.update({ status: "archived", verified: false });
  else if (m.ref.includes("/aliases/")) await ref.update({ approved: false });
  else await ref.delete(); // counts: remove the row
}
console.log(`Done (${HARD ? "hard delete" : "soft archive"}): ${all.length} docs. Backup retained for rollback.`);
```

## Why this is safe
- Default is read-only; writes need three independent gates (`--apply` + `--yes-write-to-production` +
  a typed phrase) plus owner-supplied prod credentials this repo does not hold.
- A full JSON backup is written before any change; soft-archive is the default (reversible).
- The match predicate requires BOTH the poison code AND a rivet/Manstel name, scoped away from seed/manual,
  so a real tire can never be deleted.
- The collection paths above are placeholders to be confirmed against the live schema during the dry run
  before `--apply` is ever used.
