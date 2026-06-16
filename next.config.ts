import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin uses native deps + dynamic requires; keep it external so Vercel loads it from
  // node_modules at runtime. Its transitive jwks-rsa -> jose(ESM) `require()` is fixed via patch-package
  // (patches/jwks-rsa+4.0.1.patch) so firebase-admin/auth loads without ERR_REQUIRE_ESM on Vercel.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
