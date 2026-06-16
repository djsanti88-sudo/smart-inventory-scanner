// Postinstall patch: jwks-rsa (pulled in by firebase-admin/auth) does top-level `require('jose')`, but
// jose v6 is ESM-only -> ERR_REQUIRE_ESM crashes /api/resolve-scan on Vercel's Turbopack external loader.
// Fix WITHOUT patch-package (which is fragile across line endings): string-replace the two offending sites.
//   - utils.js (used by firebase-admin's token verification): load jose via dynamic import() in the async fn.
//   - index.js: lazy-require the passport integration so its top-level require('jose') never fires on import
//     (firebase-admin never uses passport).
// Idempotent and safe if jwks-rsa is absent or already patched.
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
  ["const jose = require('jose');", "// jose is ESM-only; loaded via dynamic import() in retrieveSigningKeys (see scripts/patch-jwks-rsa.cjs)"],
  ["async function retrieveSigningKeys(jwks) {", "async function retrieveSigningKeys(jwks) {\n  const jose = await import('jose');"],
]);

patch("node_modules/jwks-rsa/src/index.js", [
  ["const { passportJwtSecret } = require('./integrations/passport');", "// passport integration lazy-loaded below (its top-level require('jose') would crash on import)"],
  [
    "module.exports.passportJwtSecret = passportJwtSecret;",
    "Object.defineProperty(module.exports, 'passportJwtSecret', { configurable: true, enumerable: true, get() { return require('./integrations/passport').passportJwtSecret; } });",
  ],
]);
