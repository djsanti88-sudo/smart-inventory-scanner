import { makeVitestConfig, performanceSuitePaths } from "./vitest.config";

export default makeVitestConfig([
  ...performanceSuitePaths,
  "scripts/__tests__/render-report-pdf.test.mjs",
]);
