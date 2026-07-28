#!/usr/bin/env node
// Post-deploy smoke fingerprint (Never-Again Decision Package, item 3).
//
// Hits a DEPLOYED URL with read-only GET requests only (no paid calls, no writes) and asserts:
//   1. /api/ai-lookup capability JSON matches scripts/smoke-expected.json (missingKeys empty,
//      goUpc.configured, daily.limit, decodeLadder order, geminiUsedForDecode false).
//   2. Route fingerprint: /scan (200|307), /history 200, /catalog-review 200, /reconcile 200,
//      /sessions 200.
//   3. Vercel's "Deployment has failed" masquerade page: a failed-build deployment can still answer
//      200 while serving Vercel's own error HTML instead of the app. Checked on /scan's body.
//
// Usage:
//   node scripts/smoke-fingerprint.mjs <https://deployment-url>
//   node scripts/smoke-fingerprint.mjs <https://deployment-url> --expect-lineage-mismatch
//
// Exit 0 = every check passed. Exit 1 = at least one mismatch (diff printed). Exit 2 = usage/network error.
//
// --expect-lineage-mismatch is for self-test only: it tells the script's own self-test runner that a
// FAILURE on this target is the expected, documented outcome (proving the script actually discriminates
// between deployments), so the self-test harness can still exit 0 overall.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = path.join(__dirname, "smoke-expected.json");

const FAILED_DEPLOY_MARKERS = [
  "Deployment has failed",
  "This deployment cannot be found",
  "DEPLOYMENT_NOT_FOUND",
];

const ROUTE_FINGERPRINT = [
  { path: "/scan", expectedStatuses: [200, 307] },
  { path: "/history", expectedStatuses: [200] },
  { path: "/catalog-review", expectedStatuses: [200] },
  { path: "/reconcile", expectedStatuses: [200] },
  { path: "/sessions", expectedStatuses: [200] },
];

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function loadExpected() {
  let raw;
  try {
    raw = readFileSync(EXPECTED_PATH, "utf8");
  } catch (e) {
    fail(`Cannot read ${EXPECTED_PATH}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON in ${EXPECTED_PATH}: ${e.message}`);
  }
}

async function getJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "manual" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON, caller decides */
    }
    return { status: res.status, text, json, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

async function getText(url, timeoutMs = 15000) {
  return getJson(url, timeoutMs);
}

function diffValue(label, expected, actual, mismatches) {
  const same = JSON.stringify(expected) === JSON.stringify(actual);
  if (!same) {
    mismatches.push({ label, expected, actual });
  }
  return same;
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

async function runCapabilityCheck(baseUrl, expected, mismatches) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/ai-lookup`;
  let result;
  try {
    result = await getJson(url);
  } catch (e) {
    mismatches.push({ label: "GET /api/ai-lookup", expected: "reachable JSON response", actual: `fetch failed: ${e.message}` });
    return;
  }
  if (result.status !== 200) {
    mismatches.push({ label: "GET /api/ai-lookup status", expected: 200, actual: result.status });
  }
  if (!result.json) {
    mismatches.push({ label: "GET /api/ai-lookup body", expected: "valid JSON", actual: result.text.slice(0, 300) });
    return;
  }
  const body = result.json;
  const exp = expected.aiLookup;

  // missingKeys must be empty (all provider keys configured in this deployment).
  const missingKeys = Array.isArray(body.missingKeys) ? body.missingKeys : ["<missing field>"];
  if (missingKeys.length !== 0) {
    mismatches.push({ label: "missingKeys (expect empty)", expected: [], actual: missingKeys });
  }

  // goUpc.configured
  diffValue("goUpc.configured", exp.goUpcConfigured, body.goUpc?.configured, mismatches);

  // daily.limit
  diffValue("daily.limit", exp.dailyLimit, body.daily?.limit, mismatches);

  // decodeLadder order
  if (!arraysEqual(body.decodeLadder, exp.decodeLadder)) {
    mismatches.push({ label: "decodeLadder order", expected: exp.decodeLadder, actual: body.decodeLadder });
  }

  // geminiUsedForDecode must be false (Gemini is permanently out of decode - L11)
  diffValue("geminiUsedForDecode", false, body.geminiUsedForDecode, mismatches);
}

async function runRouteFingerprint(baseUrl, mismatches) {
  const failedDeployBodies = {};
  for (const { path: routePath, expectedStatuses } of ROUTE_FINGERPRINT) {
    const url = `${baseUrl.replace(/\/$/, "")}${routePath}`;
    let result;
    try {
      result = await getText(url);
    } catch (e) {
      mismatches.push({ label: `GET ${routePath}`, expected: expectedStatuses, actual: `fetch failed: ${e.message}` });
      continue;
    }
    if (!expectedStatuses.includes(result.status)) {
      mismatches.push({ label: `GET ${routePath} status`, expected: expectedStatuses, actual: result.status });
    }
    if (routePath === "/scan") {
      failedDeployBodies.scan = result.text;
    }
  }
  return failedDeployBodies;
}

function checkFailedDeployMasquerade(bodies, mismatches) {
  const scanBody = bodies.scan || "";
  for (const marker of FAILED_DEPLOY_MARKERS) {
    if (scanBody.includes(marker)) {
      mismatches.push({
        label: "Vercel failed-deploy masquerade page on /scan",
        expected: "app HTML (no Vercel error markers)",
        actual: `body contains "${marker}"`,
      });
    }
  }
}

function printMismatches(baseUrl, mismatches) {
  console.error(`\nSMOKE FINGERPRINT MISMATCH against ${baseUrl}\n`);
  for (const m of mismatches) {
    console.error(`  - ${m.label}`);
    console.error(`      expected: ${JSON.stringify(m.expected)}`);
    console.error(`      actual:   ${JSON.stringify(m.actual)}`);
  }
  console.error(`\n${mismatches.length} mismatch(es).`);
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = args[0];
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    fail("Usage: node scripts/smoke-fingerprint.mjs <deployment-url>");
  }

  const expected = loadExpected();
  const mismatches = [];

  await runCapabilityCheck(baseUrl, expected, mismatches);
  const bodies = await runRouteFingerprint(baseUrl, mismatches);
  checkFailedDeployMasquerade(bodies, mismatches);

  if (mismatches.length > 0) {
    printMismatches(baseUrl, mismatches);
    process.exit(1);
  }

  console.log(`SMOKE FINGERPRINT PASSED against ${baseUrl}`);
  console.log("  - /api/ai-lookup capability JSON matches smoke-expected.json");
  console.log("  - route fingerprint matches (200/307 as expected, including /sessions 200)");
  console.log("  - no Vercel failed-deploy masquerade detected on /scan");
  process.exit(0);
}

main().catch((e) => {
  console.error("Smoke fingerprint crashed:", e);
  process.exit(2);
});
