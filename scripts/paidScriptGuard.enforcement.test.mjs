// ENFORCEMENT TEST for scripts/lib/paidScriptGuard.mjs. This is the real deliverable of the
// 2026-08-13 money-hole closure (TL2-1): it makes the TWELFTH unguarded paid script impossible to
// add silently. It scans every file under scripts/ and FAILS if a script reads .env.local while
// also referencing a provider key or a billed endpoint, unless it imports the shared guard (or is
// on the small explicit allowlist below, each entry with a written reason).
//
// Background: scripts/model-bakeoff.mjs read .env.local's OPENAI_API_KEY on a bare invocation and
// fired live paid calls with no flag, causing a real owner charge (2026-07-26). It was fixed, but
// 9 sibling scripts were found still doing the identical thing (TL2-1, 2026-08-13), plus 3 more
// found re-verifying that list by hand. This test is what closes the CLASS, not just the instances.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SCRIPTS_ROOT = path.resolve(process.cwd(), "scripts");
const SELF = path.resolve(process.cwd(), "scripts/paidScriptGuard.enforcement.test.mjs");
const GUARD_MODULE = path.resolve(process.cwd(), "scripts/lib/paidScriptGuard.mjs");

// Directories that are not live dev-tooling surface: archived/quarantined probe output, node_modules,
// and build artifacts. scripts/archive-tmp-2026-07/ is the project's established disposal pattern for
// dead one-off probes (see docs/superpowers/reports/2026-08-12-sweep-E-findings.md, E-4) and is
// gitignored - it is not a live surface a twelfth offender could be added to unnoticed.
const EXCLUDED_DIR_SEGMENTS = ["node_modules", "archive-tmp-2026-07", ".git"];

// An actual read of .env.local (not just a comment/string mentioning the filename). Matches both the
// raw fs.readFileSync/createReadStream pattern used throughout scripts/ and the shared loader.
const ENV_LOCAL_READ_PATTERNS = [
  /readFileSync\([^)]*\.env\.local/,
  /createReadStream\([^)]*\.env\.local/,
  /loadEnvLocal\s*\(/,
  // String-obfuscated variants: ".env" and ".local" built as two literals joined with `+` (either
  // order) instead of one literal, e.g. fs.readFileSync(path.join(dir, ".env" + ".local")). This is
  // a heuristic, not a parser -- it only catches the two-literal-concat shape, not template
  // literals, char-code building, base64, or a var assembled elsewhere and referenced by name. See
  // the class note below and the test's own honesty comment.
  /["']\.env["']\s*\+\s*["']\.local["']/,
  /["']\.local["']\s*\+\s*["']\.env["']/,
];

// Provider keys and billed endpoints that make a .env.local read dangerous. Deliberately narrow to
// the paid/billed surface named in CLAUDE.md's Delegation Model Policy and the Paid API Cost Truth
// Rule - NOT Turso/Firebase (those are Lane-2-legitimate data-store credentials, not per-call billed
// AI/discovery providers, and are not the class this guard exists to close).
const BILLED_KEYWORD_PATTERNS = [
  /api\.openai\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /go-upc/i,
  /GO_UPC_API_KEY/,
  /firecrawl/i,
  /FIRECRAWL_API_KEY/,
  /brave/i,
  /BRAVE_SEARCH_API_KEY/,
  /upcitemdb/i,
  /OPENAI_API_KEY/,
  /GEMINI_API_KEY/,
];

const IMPORTS_GUARD_PATTERN = /paidScriptGuard(\.mjs)?["']/;

// Hostnames that are never a billed third-party surface -- local dev servers, the app's own preview/
// prod deploys under test, and loopback addresses.
const NON_BILLED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

// Broader-than-the-keyword-list detection: a fetch/axios call to ANY non-localhost external host is
// suspicious enough to flag, independent of whether the host happens to be on BILLED_KEYWORD_PATTERNS
// -- this is what catches a billed provider added later that nobody remembered to add to the keyword
// list. Deliberately simple regex, not a real URL/AST parser (see honesty note at bottom of file).
const EXTERNAL_FETCH_PATTERN = /\b(?:fetch|axios(?:\s*\.\s*(?:get|post|put|patch|delete|request))?)\s*\(\s*[`'"]https?:\/\/([a-zA-Z0-9.-]+)/g;

// Local (same-package) relative import/require specifiers, one level -- `./foo.mjs`, `../lib/bar`,
// import(...) and require(...) forms. Bare package specifiers (e.g. "node:fs", "vitest") are
// intentionally excluded; this class of evasion is about a script hiding the read behind ITS OWN
// helper module, not about a third-party dependency.
const LOCAL_IMPORT_PATTERN = /(?:from\s+|require\(\s*|import\(\s*)["'](\.\.?\/[^"']+)["']/g;

/**
 * Small explicit allowlist for files that legitimately read .env.local and mention a billed
 * keyword WITHOUT importing the guard. Every entry needs a written reason. Keep this list short -
 * a growing allowlist defeats the point of the test.
 */
const ALLOWLIST = {
  // Owner-authorized 2026-07-20: copies already-configured key VALUES from .env.local straight into
  // Vercel's preview/production env store via `vercel env add` (values never printed/logged). This
  // is a key-provisioning utility, not a paid-API-calling script - it never itself calls
  // api.openai.com/generativelanguage.googleapis.com/Firecrawl/etc, so the guard's --live/
  // --yes-i-accept-cost spend gate does not apply to it. The billed-keyword match here is the
  // Firecrawl/OpenAI/Brave var NAMES it copies, not a call it makes.
  "scripts/stress/sync-preview-keys.mjs": "key-copy utility (Vercel env), no paid API call of its own",
  "scripts/stress/sync-production-keys.mjs": "key-copy utility (Vercel env), no paid API call of its own",
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_SEGMENTS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(mjs|mts|ts|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readsEnvLocal(content) {
  return ENV_LOCAL_READ_PATTERNS.some((re) => re.test(content));
}

function referencesExternalFetchSurface(content) {
  EXTERNAL_FETCH_PATTERN.lastIndex = 0;
  let match;
  while ((match = EXTERNAL_FETCH_PATTERN.exec(content))) {
    const host = (match[1] || "").toLowerCase();
    if (host && !NON_BILLED_HOSTS.has(host)) return true;
  }
  return false;
}

function referencesBilledSurface(content) {
  return BILLED_KEYWORD_PATTERNS.some((re) => re.test(content)) || referencesExternalFetchSurface(content);
}

function importsGuard(content) {
  return IMPORTS_GUARD_PATTERN.test(content);
}

/**
 * Resolve local (relative) import/require specifiers found in `content` to real files on disk, ONE
 * level deep -- the class this closes is "a helper module does the read/reference and the caller
 * just imports it," not arbitrarily deep indirection chains (which a regex-based scanner cannot
 * chase reliably without becoming a real module resolver).
 */
function resolveLocalImports(content, fromFile) {
  const dir = path.dirname(fromFile);
  const specifiers = new Set();
  LOCAL_IMPORT_PATTERN.lastIndex = 0;
  let match;
  while ((match = LOCAL_IMPORT_PATTERN.exec(content))) specifiers.add(match[1]);

  const resolved = [];
  const candidateSuffixes = ["", ".mjs", ".js", ".cjs", ".ts", "/index.mjs", "/index.js", "/index.ts"];
  for (const spec of specifiers) {
    const base = path.resolve(dir, spec);
    for (const suffix of candidateSuffixes) {
      const candidate = base + suffix;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        resolved.push(candidate);
        break;
      }
    }
  }
  return resolved;
}

/**
 * Effective content for a file = its own source plus the source of every local import it pulls in
 * (one level). This is what closes the "helper module does the dangerous thing, caller just imports
 * it" evasion: readsEnvLocal/referencesBilledSurface/importsGuard are evaluated over this combined
 * text, not just the file's own bytes.
 */
function effectiveContent(file, content, cache) {
  const imported = resolveLocalImports(content, file);
  let combined = content;
  for (const imp of imported) {
    if (path.resolve(imp) === path.resolve(file)) continue; // no self-import loops
    if (!cache.has(imp)) {
      try {
        cache.set(imp, fs.readFileSync(imp, "utf8"));
      } catch {
        cache.set(imp, "");
      }
    }
    combined += "\n" + cache.get(imp);
  }
  return combined;
}

describe("paid script guard enforcement (TL2-1 class-wide closure)", () => {
  it("guard module exists and never itself reads .env.local", () => {
    expect(fs.existsSync(GUARD_MODULE)).toBe(true);
    const guardSrc = fs.readFileSync(GUARD_MODULE, "utf8");
    expect(readsEnvLocal(guardSrc)).toBe(false);
  });

  it("no script under scripts/ reads .env.local while referencing a provider key or billed endpoint without importing the guard (direct OR via a one-level local import)", () => {
    const files = walk(SCRIPTS_ROOT).filter((f) => path.resolve(f) !== SELF && path.resolve(f) !== GUARD_MODULE);
    const violations = [];
    const importCache = new Map();

    for (const file of files) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
      if (ALLOWLIST[rel]) continue;
      const content = fs.readFileSync(file, "utf8");
      const combined = effectiveContent(file, content, importCache);
      if (readsEnvLocal(combined) && referencesBilledSurface(combined) && !importsGuard(combined)) {
        violations.push(rel);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `${violations.length} script(s) read .env.local AND reference a provider key/billed endpoint ` +
        `(directly or through a local helper module they import) without importing ` +
        `scripts/lib/paidScriptGuard.mjs:\n  - ${violations.join("\n  - ")}\n\n` +
        `Fix: either migrate the script onto requireLiveApproval()/requireDevToolingKey() from the ` +
        `guard (see scripts/model-bakeoff.mjs or scripts/phase1-enrich-build.mjs for the pattern), ` +
        `delete the script if it's a finished one-off investigation, or add it to this test's ` +
        `ALLOWLIST with a written reason if it is a genuine, reviewed exception.`
      );
    }
  });

  it("every currently-allowlisted entry still exists (no stale exemptions)", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(fs.existsSync(path.resolve(process.cwd(), rel)), `allowlisted file ${rel} no longer exists - remove its entry`).toBe(true);
    }
  });

  it("every allowlist entry carries a real written reason, not a placeholder", () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(typeof reason, `allowlist entry for ${rel} must be a string reason`).toBe("string");
      expect(reason.trim().length, `allowlist entry for ${rel} has no meaningful written reason`).toBeGreaterThan(15);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// HONESTY NOTE (what this guard still CANNOT catch, 2026-08-16 hardening pass):
//   - Import indirection deeper than one level (helper A imports helper B which does the read).
//   - Non-relative indirection: a helper resolved via a bare package specifier, a dynamically
//     computed import path (`import(someVar)`), or code loaded via eval/new Function.
//   - String obfuscation shapes other than the two-literal `"...".env" + ".local"` concat this file
//     now matches -- template literals (`${".env"}.local`), char-code/base64 building, or a string
//     assembled in one file and merely referenced by variable name in another.
//   - A billed provider whose calls never appear as a literal `fetch("https://...")` /
//     `axios(...)` call in this file's plain text -- e.g. built through an SDK client object
//     (`new OpenAI().chat...`) with no literal external URL in this repo, or a URL built entirely
//     from runtime string concatenation/env vars with no literal hostname visible statically.
// This is a regex-based lint gate, not a real JS parser or dataflow analyzer. It raises the bar
// materially (indirection-by-helper and the two-literal obfuscation shape are now closed, and any
// literal external fetch/axios call is flagged regardless of keyword list membership) without
// pretending to be complete.
// ---------------------------------------------------------------------------------------------
