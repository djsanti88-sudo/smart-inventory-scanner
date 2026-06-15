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
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/services/**/*.test.ts"],
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
