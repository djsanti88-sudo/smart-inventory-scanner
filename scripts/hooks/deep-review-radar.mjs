#!/usr/bin/env node
// Deep-Review Radar (owner order 2026-07-26): deterministic, $0, runs on Stop.
// Scores the working-tree diff for risk/ROI; when it crosses the line, blocks
// the stop once with instructions for Claude to OFFER the deep-review panel
// (gpt-5.6-sol xhigh + gemini-3.6-flash-high + Fable adjudication) via a
// question. The panel itself never runs without the owner's yes.
// Debounced by diff fingerprint so the same change-set only triggers once.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const STATE = join(ROOT, ".claude", ".deep-review-radar.json");
const THRESHOLD = 25;

// F-11 (owner order, 2026-07-29): env-driven no-write/dry-run mode. When set, the radar still runs its
// full deterministic scoring (so its decision logic stays testable), but never writes the debounce state
// file to disk - proof-of-concept / test invocations must leave zero filesystem trace. Without this var
// set, behavior is byte-for-byte unchanged from before.
const NO_WRITE = process.env.SCANBIN_HOOKS_DRY_RUN === "1" || process.env.SCANBIN_HOOKS_DRY_RUN === "true";

const WEIGHTS = [
  [/scanStore|services\/inventory|resolver|idempot|pendingSync|cloudDrain/i, 5],
  [/auth|security|share\/route|firestore\.rules|firebase|sensitiveFields|serializ/i, 5],
  [/server\/decode|pipeline|ladder|upc\//i, 4],
  [/src\/services\//i, 2],
  [/src\/(components|app|stores)\//i, 1.5],
];

function git(args) {
  try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

const numstat = git(["diff", "--numstat", "HEAD"]);
let score = 0;
const hot = [];
for (const line of numstat.split("\n")) {
  const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
  if (!m) continue;
  const churn = Math.min(Number(m[1]) + Number(m[2]), 200);
  const file = m[3];
  let w = 1;
  for (const [re, weight] of WEIGHTS) if (re.test(file)) { w = Math.max(w, weight); }
  const s = (churn / 40) * w;
  score += s;
  if (w >= 4 && churn > 10) hot.push(file);
}
score = Math.round(score);

if (score < THRESHOLD) process.exit(0);

const fingerprint = createHash("sha1").update(numstat).digest("hex").slice(0, 12);
let last = "";
try { last = JSON.parse(readFileSync(STATE, "utf8")).fingerprint; } catch {}
if (last === fingerprint) process.exit(0);
if (!NO_WRITE) {
  try { writeFileSync(STATE, JSON.stringify({ fingerprint, score, at: new Date().toISOString() })); } catch {}
}

const reason =
  `DEEP-REVIEW RADAR (deterministic, $0): the current working-tree change scored ${score} ` +
  `risk points (threshold ${THRESHOLD})` +
  (hot.length ? `, touching sensitive areas: ${hot.slice(0, 5).join(", ")}` : "") +
  `. Owner standing order: when a change is this high-ROI, ASK the owner (AskUserQuestion) ` +
  `whether to run the deep-review panel (gpt-5.6-sol xhigh + gemini-3.6-flash-high clean-room ` +
  `review + Fable adjudication, subscriptions only) or skip it. Offer once, respect the answer, ` +
  `do not run any paid model without the owner's yes. If the owner was already asked about this ` +
  `exact change-set, just finish.`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
