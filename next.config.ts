import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin uses native deps + dynamic requires that break when bundled into a serverless function
  // (the /api/resolve-scan route crashes at import otherwise). Keep it external so it is required from
  // node_modules at runtime on Vercel's Node runtime.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
