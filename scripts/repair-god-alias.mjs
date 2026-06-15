#!/usr/bin/env node
// Inspect (and optionally repair) the REAL cloud god account for poisoned tire aliases.
// Read-only by default; pass --repair to unlink poisoned aliases (approved:false) + write an audit event.
// Auth: signs in as the god user via Identity Toolkit (public API key). No Admin SDK / service account.
//
// Usage:
//   node scripts/repair-god-alias.mjs                      # inspect only
//   node scripts/repair-god-alias.mjs --repair             # unlink poisoned tire aliases + audit
// Env/.env.local: NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_PROJECT_ID, GOD_EMAIL?, GOD_PASSWORD?

import { readFileSync } from "node:fs";

function envVal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const t = readFileSync("C:/Users/djsan/inventory/.env.local", "utf8");
    for (const line of t.split(/\r?\n/)) { const s = line.trim(); if (s.startsWith(name + "=")) return s.slice(name.length + 1).trim(); }
  } catch { /* ignore */ }
  return "";
}
const API_KEY = envVal("NEXT_PUBLIC_FIREBASE_API_KEY");
const PROJECT_ID = envVal("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
const EMAIL = process.env.GOD_EMAIL || "djsanti88@gmail.com";
const PASSWORD = process.env.GOD_PASSWORD || "Santiago";
const REPAIR = process.argv.includes("--repair");

const IDENTITY = "https://identitytoolkit.googleapis.com/v1/accounts";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const TIRE_CODES = new Set(["2881-6861", "28816861", "2881 6861", "2881/6861"]);
const TIRE_NORMALIZED = "28816861";
const isTireCode = (clean, normalized) =>
  TIRE_CODES.has(String(clean)) || String(normalized).replace(/[^0-9]/g, "") === TIRE_NORMALIZED || String(clean).replace(/[-\s/\\_.]+/g, "") === TIRE_NORMALIZED;

async function post(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}
async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}
const sv = (f, k) => (f?.[k]?.stringValue ?? "");
const bv = (f, k) => (f?.[k]?.booleanValue ?? false);

async function signIn() {
  const r = await post(`${IDENTITY}:signInWithPassword?key=${API_KEY}`, { email: EMAIL, password: PASSWORD, returnSecureToken: true });
  if (!r.ok) throw new Error(`sign-in failed: ${r.json?.error?.message || r.status}`);
  return { idToken: r.json.idToken, uid: r.json.localId };
}

async function listMembershipBusinessIds(uid, token) {
  // runQuery over the top-level businessMembers collection for this user.
  const r = await post(`${FS}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: "businessMembers" }],
      where: { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: uid } } },
    },
  }, token);
  const ids = new Set([`biz-${uid}`]);
  if (Array.isArray(r.json)) for (const row of r.json) { const bid = sv(row.document?.fields, "businessId"); if (bid) ids.add(bid); }
  return [...ids];
}

async function listCollection(bid, coll, token) {
  const out = [];
  let pageToken = "";
  do {
    const url = `${FS}/businesses/${bid}/${coll}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const r = await get(url, token);
    if (!r.ok) break;
    for (const d of r.json.documents ?? []) out.push({ id: d.name.split("/").pop(), fields: d.fields ?? {} });
    pageToken = r.json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

async function main() {
  if (!API_KEY || !PROJECT_ID) { console.error("Missing NEXT_PUBLIC_FIREBASE_API_KEY/PROJECT_ID"); process.exit(2); }
  const { idToken, uid } = await signIn();
  const businessIds = await listMembershipBusinessIds(uid, idToken);
  console.log(JSON.stringify({ uid, businessIds }, null, 2));

  const poisoned = [];
  for (const bid of businessIds) {
    const aliases = await listCollection(bid, "aliases", idToken);
    const products = await listCollection(bid, "products", idToken);
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const a of aliases) {
      const clean = sv(a.fields, "cleanCode");
      const normalized = sv(a.fields, "normalizedCode");
      if (!isTireCode(clean, normalized)) continue;
      const productId = sv(a.fields, "productId");
      const prod = productById.get(productId);
      const productName = prod ? sv(prod.fields, "name") : "(unknown)";
      const category = prod ? sv(prod.fields, "category") : "";
      const approved = bv(a.fields, "approved");
      const looksTire = /tire|falken/i.test(productName + " " + category);
      const entry = { bid, aliasId: a.id, clean, normalized, approved, productId, productName, category, looksTire };
      console.log("TIRE-CODE ALIAS:", JSON.stringify(entry));
      if (approved && !looksTire) poisoned.push(entry);
    }
    // also report whether a Falken/tire product exists in this business
    const tireProducts = products.filter((p) => /tire|falken/i.test(sv(p.fields, "name") + " " + sv(p.fields, "category")));
    if (tireProducts.length) console.log(`Falken/tire products in ${bid}:`, tireProducts.map((p) => `${p.id}:${sv(p.fields, "name")}`).join(", "));
  }

  console.log("\nPOISONED (approved tire code on a non-tire product):", JSON.stringify(poisoned, null, 2));

  if (REPAIR && poisoned.length) {
    const now = new Date().toISOString();
    for (const p of poisoned) {
      // Find a Falken/tire product in the same business to MOVE the alias to. If one exists, re-point the
      // alias (productId -> tire) keeping approved=true so the tire code resolves to the tire. Otherwise
      // UNLINK (approved:false) so it stops resolving to the wrong product (and falls to Needs Review).
      const products = await listCollection(p.bid, "products", idToken);
      const tire = products.find((pr) => /falken/i.test(sv(pr.fields, "name") + " " + sv(pr.fields, "category")))
        || products.find((pr) => /tire/i.test(sv(pr.fields, "name") + " " + sv(pr.fields, "category")));
      const docUrl = `${FS}/businesses/${p.bid}/aliases/${p.aliasId}`;
      const cur = await get(docUrl, idToken);
      const fields = cur.json.fields ?? {};
      let toProductName = "";
      let masks = "updateMask.fieldPaths=updatedAt";
      fields.updatedAt = { timestampValue: now };
      if (tire) {
        fields.productId = { stringValue: tire.id };
        fields.approved = { booleanValue: true };
        masks += "&updateMask.fieldPaths=productId&updateMask.fieldPaths=approved";
        toProductName = sv(tire.fields, "name");
      } else {
        fields.approved = { booleanValue: false };
        masks += "&updateMask.fieldPaths=approved";
      }
      const patch = await fetch(`${docUrl}?${masks}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ fields }),
      });
      // Audit event (append-only auditLog).
      const auditId = `repair-${p.aliasId}-${Date.now()}`;
      await fetch(`${FS}/businesses/${p.bid}/auditLog/${auditId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ fields: {
          businessId: { stringValue: p.bid }, actorUserId: { stringValue: uid }, entityType: { stringValue: "Alias" }, entityId: { stringValue: p.aliasId },
          action: { stringValue: "alias_moved_or_unlinked" }, reason: { stringValue: "human_mistake_repair_live_account" },
          rawCode: { stringValue: p.clean }, normalizedCode: { stringValue: "28816861" },
          fromProduct: { stringValue: p.productName }, toProduct: { stringValue: toProductName }, createdAt: { timestampValue: now },
        } }),
      });
      console.log(`REPAIRED alias ${p.aliasId} (was -> ${p.productName}): ${tire ? `MOVED -> ${toProductName}` : "UNLINKED"}; status ${patch.status}`);
    }
  } else if (REPAIR) {
    console.log("Nothing to repair.");
  }
}
main().catch((e) => { console.error("repair-god-alias failed:", e.message || e); process.exit(1); });
