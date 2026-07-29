// Postinstall patch: jwks-rsa (pulled in by firebase-admin/auth) does top-level `require('jose')`, but
// jose v6 is ESM-only -> ERR_REQUIRE_ESM crashes /api/resolve-scan on Vercel's Turbopack external loader.
// Fix WITHOUT patch-package (fragile across line endings) AND fully idempotently:
//   - utils.js: drop the top-level require; call jose inline via `(await import('jose')).xxx` at each use.
//   - index.js: lazy-require the passport integration so its top-level require('jose') never fires on
//     import (firebase-admin never uses passport).
//
// HASH VERIFICATION (F-14, 2026-07-29): the old version of this script did a bare string-replace and
// silently no-op'd if the markers were not found - meaning an upstream jwks-rsa release that reshuffled
// these files would make the patch silently do nothing, and the ESM crash would only surface at RUNTIME
// on Vercel with no build-time signal. This version verifies each target file's exact content against a
// known-good sha256 (of BOTH the pristine original and the already-patched result) before touching it:
//   - hash matches the known ORIGINAL  -> apply the edits, verify the result hashes to the known PATCHED
//     value, then write (or throw if the patch produced something unexpected).
//   - hash matches the known PATCHED   -> already patched; no-op (idempotent re-run, e.g. repeated CI
//     installs or a warm node_modules).
//   - hash matches NEITHER             -> upstream shipped different content than this patch was written
//     for. THROW LOUDLY (nonzero exit fails `npm install`/`npm ci`) instead of silently skipping, so the
//     hazard surfaces at install time, not as a production crash.
//   - file absent                      -> jwks-rsa not installed under this layout; skip (matches prior
//     "safe if jwks-rsa is absent" behavior - this is not drift, it's an optional/differently-shaped tree).
const fs = require("fs");
const crypto = require("crypto");

// Known-good hashes for jwks-rsa@4.0.1's src/utils.js and src/index.js, computed from the exact
// pristine (pre-patch) file and the exact fully-patched file this script produces. If jwks-rsa ships a
// new version with different source, both hashes will fail to match and verifyAndPatch throws.
const TARGETS = {
  "node_modules/jwks-rsa/src/utils.js": {
    edits: [
      ["const jose = require('jose');", "// jose (ESM-only) is imported inline below; see scripts/patch-jwks-rsa.cjs"],
      ["await jose.importJWK(", "await (await import('jose')).importJWK("],
      ["await jose.exportSPKI(", "await (await import('jose')).exportSPKI("],
    ],
    originalSha256: "c535773fd798202296e846e7c057f96f631148686194ff2990f0729fa4c1b7af",
    patchedSha256: "e87c0aaeb10d25312a3fb75af925e8e14cbd06ef82a5ac952e84e983e322a662",
  },
  "node_modules/jwks-rsa/src/index.js": {
    edits: [
      ["const { passportJwtSecret } = require('./integrations/passport');", "// passport integration lazy-loaded below (its top-level require('jose') would crash on import)"],
      [
        "module.exports.passportJwtSecret = passportJwtSecret;",
        "Object.defineProperty(module.exports, 'passportJwtSecret', { configurable: true, enumerable: true, get() { return require('./integrations/passport').passportJwtSecret; } });",
      ],
    ],
    originalSha256: "b612939baccecd0301f4f7f2a15d9e3a6c5e45d3dadfc2e3cc53532d6f39f375",
    patchedSha256: "26f970cc04ef152f184989f99f313d181b95d8efada077b04f9e5c6e039aa5a9",
  },
};

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function applyEdits(src, edits) {
  let out = src;
  for (const [from, to] of edits) out = out.split(from).join(to);
  return out;
}

/**
 * Verify one target file's content against the known original/patched hashes and patch it if needed.
 * `io` is injectable (readFileSync/writeFileSync/existsSync) so tests can point this at a temp fixture
 * directory instead of the real node_modules tree.
 * Returns a status string: "absent" | "already-patched" | "patched".
 * Throws on drift (content matches neither known hash) or on an unexpected patch result.
 */
function verifyAndPatch(file, spec, io = fs) {
  if (!io.existsSync(file)) return "absent";
  const src = io.readFileSync(file, "utf8");
  const hash = sha256(src);
  if (hash === spec.patchedSha256) return "already-patched";
  if (hash !== spec.originalSha256) {
    throw new Error(
      `patch-jwks-rsa: ${file} content (sha256 ${hash}) matches neither the known-good original ` +
      `(${spec.originalSha256}) nor the known-good patched (${spec.patchedSha256}) hash this patch was ` +
      `written against. Upstream jwks-rsa likely shipped different source - update ` +
      `scripts/patch-jwks-rsa.cjs's edits/hashes before installing, or the jose ESM-require crash will ` +
      `ship to production unpatched and undetected.`
    );
  }
  const patched = applyEdits(src, spec.edits);
  const patchedHash = sha256(patched);
  if (patchedHash !== spec.patchedSha256) {
    throw new Error(
      `patch-jwks-rsa: ${file} patch produced unexpected output (sha256 ${patchedHash}, expected ` +
      `${spec.patchedSha256}) - aborting without writing.`
    );
  }
  io.writeFileSync(file, patched);
  console.log("patched", file);
  return "patched";
}

function runAll(targets = TARGETS, io = fs) {
  const results = {};
  for (const [file, spec] of Object.entries(targets)) {
    results[file] = verifyAndPatch(file, spec, io);
  }
  return results;
}

if (require.main === module) {
  runAll();
}

module.exports = { verifyAndPatch, runAll, sha256, applyEdits, TARGETS };
