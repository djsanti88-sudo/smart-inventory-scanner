import { makeVitestConfig, performanceSuitePaths } from "./vitest.config";

export default makeVitestConfig([
  ...performanceSuitePaths,
  "src/server/tire-knowledge/dtHarvestIntegration.test.ts",
]);
