import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const devConnectSources = isDev ? " http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*" : "";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  `connect-src 'self' https: wss:${devConnectSources}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  // Native-dep / dynamic-require packages must stay external so Vercel loads them from node_modules
  // at runtime instead of bundling them (which breaks their runtime resolution):
  //   - firebase-admin: native deps; jwks-rsa->jose(ESM) `require()` fixed via patch-package.
  //   - better-sqlite3: native module (local-dev SQLite only).
  //   - @libsql/client: the Turso driver (dynamic import in retailKnowledgeIndex.getTursoClient).
  //     Without this it failed to load on Vercel, so BOTH the retail and tire corpora silently fell
  //     through to paid AI (2026-07-09). External-izing it makes the Turso corpus lookups work.
  serverExternalPackages: ["firebase-admin", "better-sqlite3", "@libsql/client"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          {
            key: "Permissions-Policy",
            // The inventory scanner needs same-origin camera access; unrelated sensitive browser
            // capabilities stay disabled.
            value: "camera=(self), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },

  // NOTE: the tire corpus is now served from Turso (table `tires`) like retail, so we no longer
  // bundle the 68MB tireKnowledge.generated.json into the function (it is .vercelignored). The old
  // outputFileTracingIncludes for that JSON was removed with the move to Turso.
};

export default nextConfig;
