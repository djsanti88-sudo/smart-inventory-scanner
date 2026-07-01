import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin + better-sqlite3 use native deps + dynamic requires; keep them external so Vercel
  // loads them from node_modules at runtime. firebase-admin/auth jwks-rsa -> jose(ESM) `require()` is
  // fixed via patch-package (patches/jwks-rsa+4.0.1.patch).
  serverExternalPackages: ["firebase-admin", "better-sqlite3"],

  // The gzipped SQLite knowledge DB (knowledge.generated.db.gz) is gitignored and is NOT deployed
  // to Vercel, so getKnowledgeDb() always returns null in production. Ship the committed tire JSON
  // (barcodeIndex/partNumberIndex) instead so the in-memory JSON fallback in tireKnowledgeIndex.ts
  // has its data file in the function bundle.
  outputFileTracingIncludes: {
    "/api/ai-lookup": ["./src/server/tire-knowledge/tireKnowledge.generated.json"],
  },
};

export default nextConfig;
