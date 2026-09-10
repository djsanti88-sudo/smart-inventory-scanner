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
    // Emulator-backed rules tests (src/sync-database/cloud/*.rules.test.ts) do real Firestore I/O
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
          // STRUCTURE-INDEPENDENT (folder reorganization, Project A): projects are selected by file
          // EXTENSION plus two named DOM exceptions, never by feature-folder path. A directory glob
          // silently stops collecting when its folder is renamed - the suite still reports green while
          // hundreds of tests quietly vanish. Extension-based globs cannot fail that way.
          //   unit -> every *.test.ts under src/ (node env), except the DOM exceptions below
          //   dom  -> every *.test.tsx, plus the store + camera suites that need a real DOM
          include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
          // src/services/camera touches window.BarcodeDetector and HTMLVideoElement, which need a DOM -
          // excluded here and picked up by the "dom" project below instead. Same for the Zustand store
          // suites, which render/persist against browser storage.
          // scripts/kkm-catalog, refresh-tire-meta, and boss-workbook-reconcile-dryrun are node:test
          // suites run via `node --test`, not vitest - vitest's glob would otherwise collect them and
          // fail with "No test suite found". (The tire-db-repair migration suites that used to need
          // the same exclusion were deleted 2026-09-08 - shipped one-off migrations, dead in every
          // environment; see scripts/tire-db-repair/TURSO_PROMOTION_RUNBOOK.md for the rollback record.)
          exclude: [
            "src/scanning/camera/**",
            "src/stores/**",
            "scripts/kkm-catalog/**/*.test.mjs",
            "scripts/refresh-tire-meta.test.mjs",
            "scripts/boss-workbook-reconcile-dryrun.test.mjs",
            // Named *.test.mjs (not *.node-test.mjs) but uses node:test's own API -- matches
            // this project's include glob and crashes vitest ("No test suite found") if not
            // excluded. Caught 2026-09-09 re-verifying proof:all after this file was added.
            "scripts/proof-scope.test.mjs",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          // Extension-based, folder-independent (see the "unit" project note above).
          include: ["src/**/*.test.tsx", "src/stores/**/*.test.ts", "src/scanning/camera/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
