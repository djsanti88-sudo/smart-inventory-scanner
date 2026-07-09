import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native-dep / dynamic-require packages must stay external so Vercel loads them from node_modules
  // at runtime instead of bundling them (which breaks their runtime resolution):
  //   - firebase-admin: native deps; jwks-rsa->jose(ESM) `require()` fixed via patch-package.
  //   - better-sqlite3: native module (local-dev SQLite only).
  //   - @libsql/client: the Turso driver (dynamic import in retailKnowledgeIndex.getTursoClient).
  //     Without this it failed to load on Vercel, so BOTH the retail and tire corpora silently fell
  //     through to paid AI (2026-07-09). External-izing it makes the Turso corpus lookups work.
  serverExternalPackages: ["firebase-admin", "better-sqlite3", "@libsql/client"],

  // NOTE: the tire corpus is now served from Turso (table `tires`) like retail, so we no longer
  // bundle the 68MB tireKnowledge.generated.json into the function (it is .vercelignored). The old
  // outputFileTracingIncludes for that JSON was removed with the move to Turso.
};

export default nextConfig;
