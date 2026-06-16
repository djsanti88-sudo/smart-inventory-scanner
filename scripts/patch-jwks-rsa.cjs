// Postinstall patch: jwks-rsa (pulled in by firebase-admin/auth) does top-level `require('jose')`, but
// jose v6 is ESM-only -> ERR_REQUIRE_ESM crashes /api/resolve-scan on Vercel's Turbopack external loader.
// Fix WITHOUT patch-package (fragile across line endings) AND fully idempotently (no `const jose`
// declaration, so it can never double-declare even if re-run on an already-patched/cached tree):
//   - utils.js: drop the top-level require; call jose inline via `(await import('jose')).xxx` at each use.
//   - index.js: lazy-require the passport integration so its top-level require('jose') never fires on
//     import (firebase-admin never uses passport).
// Each `from` string disappears after patching, so re-runs are no-ops. Safe if jwks-rsa is absent.
const fs = require("fs");

function patch(file, edits) {
  let src;
  try { src = fs.readFileSync(file, "utf8"); } catch { return; }
  let changed = false;
  for (const [from, to] of edits) {
    if (src.includes(from)) { src = src.split(from).join(to); changed = true; }
  }
  if (changed) { fs.writeFileSync(file, src); console.log("patched", file); }
}

patch("node_modules/jwks-rsa/src/utils.js", [
  ["const jose = require('jose');", "// jose (ESM-only) is imported inline below; see scripts/patch-jwks-rsa.cjs"],
  ["await jose.importJWK(", "await (await import('jose')).importJWK("],
  ["await jose.exportSPKI(", "await (await import('jose')).exportSPKI("],
]);

patch("node_modules/jwks-rsa/src/index.js", [
  ["const { passportJwtSecret } = require('./integrations/passport');", "// passport integration lazy-loaded below (its top-level require('jose') would crash on import)"],
  [
    "module.exports.passportJwtSecret = passportJwtSecret;",
    "Object.defineProperty(module.exports, 'passportJwtSecret', { configurable: true, enumerable: true, get() { return require('./integrations/passport').passportJwtSecret; } });",
  ],
]);
