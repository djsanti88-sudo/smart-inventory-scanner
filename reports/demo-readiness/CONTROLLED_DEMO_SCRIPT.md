# Controlled Demo Script (Window 2)

**Audience:** Santiago, presenting a **controlled demo** (not a public launch).
**Branch:** `demo-readiness-vercel-partnumber` (base `7090873`).
**Goal:** show that customers see useful product info (name + **part number**) while **all** raw codes,
barcodes, aliases, and AI/provider internals stay hidden — backed by SecurityLeakBot proof.

> Keep this short enough to follow in the final review hour. Two browser profiles (or two windows /
> incognito) make the platformOwner-vs-customer contrast obvious.

---

## 0. Before you start (1 min)
- Open two sessions: **A = platformOwner** (`djsanti88@gmail.com`), **B = customer demo account**.
- Confirm you are on the **controlled demo URL** (or `npm run dev` locally for a local demo).
- Confirm the demo catalog is **fake/seed data only** — no real customer data.

---

## 1. platformOwner login (Session A)
- Log in as `djsanti88@gmail.com`.
- Point out: the **Live Scan Feed** and tables show **Raw code / Clean code** columns, **Primary barcode**,
  **GTIN/UPC/EAN**, **Codes (aliases)**, and the AI/provider status line on the Scan page.
- Message: *"This is the platform-owner view — I see everything, including the internal catalog plumbing."*

## 2. Customer-side demo login (Session B)
- Log in as the customer demo account.
- Point out immediately: **no Raw code / Clean code columns, no Primary barcode, no GTIN/UPC/EAN, no Codes
  panel, no AI/provider wording.**
- Message: *"Same app, customer view — the sensitive catalog data is gone."*

## 3. Scan a known product (Session B, customer)
- Click the scan box and scan/enter a known seeded product code.
- The **Live Scan Feed** adds a row.

## 4. Show product name (Session B)
- The feed row and Final Count table show the **Product** name. Customer can identify what was scanned.

## 5. Show part number (Session B)
- The feed row now shows a **Part number** column (this window's fix), and the **Final Count** and
  **Products** tables show a **Part number** column too.
- Message: *"Because we hide the barcode, the customer identifies products by the **part number** — the
  manufacturer SKU — which is shown everywhere they need it."*
- If a product has no SKU, the cell shows **"Part number missing"** — never a barcode.

## 6. Show barcode / raw code is NOT visible to the customer (Session B)
- Side-by-side with Session A: the customer view has **no** Raw code, Clean code, Primary barcode,
  GTIN/UPC/EAN, or Codes/aliases anywhere (Scan, Products, Final Count, Needs Review).
- Message: *"The customer never sees or stores the raw codes or the alias/catalog database."*

## 7. Count / session workflow (Session B)
- Start a session (name + location), scan a few items, watch quantities increment in **Final Count**.
- Finish the session. Show the count totals grouped by product.

## 8. Sanitized export (Session B)
- Click **Export → Final counts CSV**.
- Open the CSV: columns are `quantity, product_name, brand, category, specs, **part_number**, location,
  counted_at, session_id`.
- Message: *"Customer exports include the part number but **no** barcode / GTIN / UPC / EAN / aliases /
  raw codes."* (Contrast: Session A's export has all the internal columns.)

## 9. Unknown code → Needs Review (Session B)
- Scan an unfamiliar/unknown code.
- It routes to **Needs Review** (not silently counted, no crash).
- Message: *"Unknown codes are never guessed — they queue for human review. In the demo, AI lookup is off,
  so nothing is sent anywhere and no tokens are spent."*

## 10. SecurityLeakBot proof summary
- Show Window 1's proof: `reports/agent-bots/latest/security_findings.json` = `{ "findings": [] }`,
  SecurityLeakBot **P0:0 / P1:0 / P2:0**.
- Message: *"An automated bot loads the app as a customer and reports any sensitive-field exposure — it
  finds zero."*

## 11. Explain the global catalog concept (WITHOUT exposing the database)
- Message: *"Behind the scenes there's a shared product catalog that lets scans resolve to known products.
  The customer browser never downloads or holds that catalog — resolution happens server-side and only the
  product-facing result (name, part number, quantity) comes back."*
- Do **not** open any raw catalog / alias data during the customer portion.

## 12. Real-cloud caveat (be honest)
- Message: *"For real production customer scans, the server resolver (`/api/resolve-scan`) needs Firebase
  Admin credentials configured in the host/Vercel. Until that's set, customer server-resolution returns a
  graceful 'unavailable' and falls back — it never leaks and never crashes. That's an ops step, not a code
  gap."*

## 13. Framing (close)
- Message: *"This is a **controlled demo** on a private URL with fake data — not a public launch. No public
  signup, no real customer data, and nothing is deployed to production without an explicit go."*

---

### Quick fallback if anything misbehaves
- If a customer scan shows `server_resolution_unavailable`, that is the **expected** graceful fallback when
  Admin creds aren't set — switch to the platformOwner session to demo the scan path, or use the local
  mock backend (`NEXT_PUBLIC_FIREBASE_BACKEND` unset).
- Never enable AI keys live during the demo.
