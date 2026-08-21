import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Server API routes must not import the CLIENT Firebase SDK (it crashes the Vercel serverless bundle).
  // The transitive case is covered by apiRouteImportGraph.test.ts; this blocks direct mistakes too.
  {
    files: ["src/app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "firebase/firestore",
                "firebase/app",
                "firebase/auth",
                "firebase/storage",
                "firebase/database",
                "firebase/functions",
                "firebase/messaging",
                "firebase/analytics",
                "**/firebaseClient",
              ],
              message:
                "Client Firebase SDK must not be imported in a server API route (crashes the Vercel serverless bundle). Use firebase-admin, or a pure module like services/db/firebase/storeMappers.",
            },
          ],
        },
      ],
    },
  },
  // CommonJS scripts (postinstall patches, etc.) legitimately use require().
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vercel build output (gitignored artifact - never our source to lint):
    ".vercel/**",
    // Playwright's generated HTML-report assets are third-party build output, not source.
    "playwright/.cache/**",
  ]),
]);

export default eslintConfig;
