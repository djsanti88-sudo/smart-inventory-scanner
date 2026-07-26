import { defineConfig, devices } from "@playwright/experimental-ct-react";
import path from "node:path";

// Component-testing config (OPTIONAL / experimental). Mounts individual React components in a real
// Chromium browser via Vite - no Next.js server, no Zustand store, no backend. This is separate from
// the E2E suite (playwright.config.ts) and the unit suite (vitest). Run with `npm run test:ct`.
//
// Scope note: this project proves behavior primarily through E2E + vitest, so CT is intentionally a
// thin scaffold (one example spec on a pure presentational component). It exists so isolated,
// interaction-heavy components CAN be proven in a browser when that's the right tool - not as a
// blanket requirement. CT specs live in ./ct and are named *.ct.spec.tsx so they never collide with
// vitest's *.test.tsx or the E2E runner's ./e2e specs.
export default defineConfig({
  testDir: "./ct",
  testMatch: "**/*.ct.spec.tsx",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    ctViteConfig: {
      resolve: {
        alias: {
          // Mirror the tsconfig `@/*` -> `src/*` path alias so components that import "@/types"
          // etc. resolve under Vite. Keep in sync with tsconfig.json "paths". `process.cwd()` is the
          // repo root under `npm run test:ct` (avoid import.meta - Playwright loads .ts configs via
          // a CJS transform where import.meta is unavailable).
          "@": path.resolve(process.cwd(), "src"),
        },
      },
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
