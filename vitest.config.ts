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
          include: ["src/services/**/*.test.ts", "src/eval/**/*.test.ts", "src/server/**/*.test.ts", "scripts/**/*.test.mjs"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/components/**/*.test.tsx", "src/stores/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
