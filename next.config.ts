import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin + better-sqlite3 use native deps + dynamic requires; keep them external so Vercel
  // loads them from node_modules at runtime. firebase-admin/auth jwks-rsa -> jose(ESM) `require()` is
  // fixed via patch-package (patches/jwks-rsa+4.0.1.patch).
  serverExternalPackages: ["firebase-admin", "better-sqlite3"],

  // Include the gzipped SQLite knowledge DB in the serverless function bundle.
  // The full DB (76K tires + 4M retail = 342MB) compresses to ~125MB via gzip.
  // At runtime, the first cold start decompresses it to /tmp; Fluid Compute
  // reuses the instance so subsequent requests use the cached connection.
  outputFileTracingIncludes: {
    "/api/ai-lookup": ["./src/server/knowledge.generated.db.gz"],
  },
};

export default nextConfig;
