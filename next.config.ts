import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin + better-sqlite3 use native deps + dynamic requires; keep them external so Vercel
  // loads them from node_modules at runtime. firebase-admin/auth jwks-rsa -> jose(ESM) `require()` is
  // fixed via patch-package (patches/jwks-rsa+4.0.1.patch).
  serverExternalPackages: ["firebase-admin", "better-sqlite3"],

  // Include the generated SQLite knowledge DB in the serverless function bundle.
  // Currently tire-only (~20MB). The 4M retail products need an external DB (Turso)
  // because 342MB exceeds Vercel's ~250MB compressed function size limit.
  outputFileTracingIncludes: {
    "/api/ai-lookup": ["./src/server/knowledge.generated.db"],
  },
};

export default nextConfig;
