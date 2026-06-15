#!/usr/bin/env node
// Provisions an OWNER ("god") account on the REAL cloud Firebase project (smart-inventory-scanner-app):
//   1. creates (or signs into) the Auth email/password user via Identity Toolkit (public API key)
//   2. writes its userProfile, a business it owns, and its OWNER membership via Firestore REST,
//      authenticated AS THE USER (so production security rules apply - no Admin SDK, no service account)
// Idempotent: deterministic businessId = biz-<uid>; re-running just re-asserts the same docs.
//
// Usage: node scripts/create-god-account.mjs <email> <password> ["Business Name"]
// Reads NEXT_PUBLIC_FIREBASE_API_KEY + NEXT_PUBLIC_FIREBASE_PROJECT_ID from .env.local (never printed).

import { readFileSync } from "node:fs";

function envVal(name) {
  if (process.env[name]) return process.env[name];
  const t = readFileSync("C:/Users/djsan/inventory/.env.local", "utf8");
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith(name + "=")) return s.slice(name.length + 1).trim();
  }
  return "";
}

const API_KEY = envVal("NEXT_PUBLIC_FIREBASE_API_KEY");
const PROJECT_ID = envVal("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
const [, , EMAIL, PASSWORD, BIZ_NAME = "Santiago's Shop"] = process.argv;

if (!API_KEY || !PROJECT_ID) { console.error("Missing NEXT_PUBLIC_FIREBASE_API_KEY/PROJECT_ID in .env.local"); process.exit(2); }
if (!EMAIL || !PASSWORD) { console.error("Usage: node scripts/create-god-account.mjs <email> <password> [businessName]"); process.exit(2); }

const IDENTITY = "https://identitytoolkit.googleapis.com/v1/accounts";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}

async function getOrCreateUser() {
  // try sign up; if the email already exists, sign in instead.
  let res = await post(`${IDENTITY}:signUp?key=${API_KEY}`, { email: EMAIL, password: PASSWORD, returnSecureToken: true });
  if (res.ok) return { idToken: res.json.idToken, uid: res.json.localId, created: true };
  const err = res.json?.error?.message || "";
  if (err.includes("EMAIL_EXISTS")) {
    res = await post(`${IDENTITY}:signInWithPassword?key=${API_KEY}`, { email: EMAIL, password: PASSWORD, returnSecureToken: true });
    if (res.ok) return { idToken: res.json.idToken, uid: res.json.localId, created: false };
    throw new Error(`Account exists but sign-in failed (wrong password?): ${res.json?.error?.message || res.status}`);
  }
  throw new Error(`signUp failed: ${err || res.status}`);
}

// PATCH a doc at an exact path (create-or-update), authenticated as the user.
async function patchDoc(path, fields, idToken) {
  const r = await fetch(`${FS}/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Firestore write ${path} failed ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const S = (v) => ({ stringValue: String(v) });
const TS = (iso) => ({ timestampValue: iso });

async function main() {
  const now = new Date().toISOString();
  const { idToken, uid, created } = await getOrCreateUser();
  const businessId = `biz-${uid}`;

  // 1. user profile (own uid)
  await patchDoc(`userProfiles/${uid}`, { authUserId: S(uid), email: S(EMAIL), name: S("Owner"), updatedAt: TS(now) }, idToken);
  // 2. business owned by the user (bootstrap rule: createdBy == uid)
  await patchDoc(`businesses/${businessId}`, { name: S(BIZ_NAME), createdBy: S(uid), createdAt: TS(now), updatedAt: TS(now) }, idToken);
  // 3. OWNER membership (self-owner rule requires the business doc above to exist with createdBy == uid)
  await patchDoc(`businessMembers/${businessId}_${uid}`, { businessId: S(businessId), userId: S(uid), role: S("owner"), createdAt: TS(now), updatedAt: TS(now) }, idToken);

  // verify membership reads back as owner
  const v = await fetch(`${FS}/businessMembers/${businessId}_${uid}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const vj = await v.json();
  const role = vj?.fields?.role?.stringValue;

  console.log(JSON.stringify({
    ok: role === "owner",
    accountCreatedNow: created,
    email: EMAIL,
    uid,
    businessId,
    businessName: BIZ_NAME,
    role,
    project: PROJECT_ID,
  }, null, 2));
  if (role !== "owner") process.exit(1);
}

main().catch((e) => { console.error("create-god-account failed:", e.message || e); process.exit(1); });
