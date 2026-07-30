import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Two projects:
//  - "unit": pure services (no React, no next/*) run in a fast node environment.
//  - "dom":  components / hooks / store run in jsdom with the React plugin.
// The "@/*" alias mirrors tsconfig paths so imports resolve identically in tests.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next maps `server-only` to a client-throw module; under vitest (no Next bundler) it would throw
      // unconditionally, so alias it to a no-op stub to unit-test server-only modules. The real boundary
      // is enforced by the app build + the static import-boundary test.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    // Emulator-backed rules tests (src/services/db/firebase/*.rules.test.ts) do real Firestore I/O
    // against a single emulator; under parallel load on Windows the first op in a file can exceed the
    // 5s default. Generous timeouts keep them reliable without weakening assertions (fast pure unit
    // tests still complete in milliseconds).
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/services/**/*.test.ts", "src/eval/**/*.test.ts", "src/server/**/*.test.ts", "src/app/**/*.test.ts", "src/lib/**/*.test.ts", "scripts/**/*.test.mjs"],
          // src/services/camera touches window.BarcodeDetector and HTMLVideoElement, which need a DOM -
          // excluded here and picked up by the "dom" project below instead.
          // scripts/kkm-catalog and scripts/tire-db-repair/*.test.mjs are node:test suites run via
          // `node --test`, not vitest - vitest's glob would otherwise collect them and fail with
          // "No test suite found".
          exclude: [
            "src/services/camera/**",
            "scripts/kkm-catalog/**/*.test.mjs",
            "scripts/refresh-tire-meta.test.mjs",
            "scripts/tire-db-repair/03_part_number_aliases.test.mjs",
            "scripts/tire-db-repair/09_promote_preflight.test.mjs",
            "scripts/tire-db-repair/10_promote_execute.test.mjs",
            "scripts/tire-db-repair/11_twin_columns.test.mjs",
            "scripts/tire-db-repair/model_styling.test.mjs",
            "scripts/tire-db-repair/validate.test.mjs",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/components/**/*.test.tsx", "src/app/**/*.test.tsx", "src/stores/**/*.test.ts", "src/services/camera/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
