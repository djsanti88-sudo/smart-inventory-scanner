import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin + better-sqlite3 use native deps + dynamic requires; keep them external so Vercel
  // loads them from node_modules at runtime. firebase-admin/auth jwks-rsa -> jose(ESM) `require()` is
  // fixed via patch-package (patches/jwks-rsa+4.0.1.patch).
  serverExternalPackages: ["firebase-admin", "better-sqlite3"],

  // Include the generated SQLite knowledge DB in the serverless function bundle.
  // The DB is generated at build time (scripts/build-knowledge-db.mjs) and read at runtime
  // for microsecond barcode lookups with minimal memory (~5MB vs ~1GB for JSON parsing).
  outputFileTracingIncludes: {
    "/api/ai-lookup": ["./src/server/knowledge.generated.db"],
  },
};

export default nextConfig;
