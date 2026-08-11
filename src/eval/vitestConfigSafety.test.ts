import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

type ProjectConfig = {
  extends?: boolean;
  maxWorkers?: unknown;
  test?: {
    name?: string;
    environment?: string;
    include?: string[];
    exclude?: string[];
    setupFiles?: string[];
    maxWorkers?: unknown;
  };
};

type RootTestConfig = {
  maxWorkers?: unknown;
  testTimeout?: unknown;
  hookTimeout?: unknown;
  projects?: ProjectConfig[];
};

const testConfig = config.test as RootTestConfig;

describe("Vitest aggregate worker safety", () => {
  it("pins only the root aggregate worker count and preserves project boundaries", () => {
    expect(testConfig.maxWorkers).toBe(4);
    expect(testConfig.testTimeout).toBe(30_000);
    expect(testConfig.hookTimeout).toBe(30_000);

    expect(testConfig.projects).toHaveLength(2);
    const [unit, dom] = testConfig.projects!;

    expect(unit.extends).toBe(true);
    expect(dom.extends).toBe(true);

    expect("maxWorkers" in unit).toBe(false);
    expect("maxWorkers" in dom).toBe(false);
    expect("maxWorkers" in (unit.test ?? {})).toBe(false);
    expect("maxWorkers" in (dom.test ?? {})).toBe(false);

    expect(unit.test?.name).toBe("unit");
    expect(unit.test?.environment).toBe("node");
    expect(unit.test?.include).toEqual([
      "src/services/**/*.test.ts",
      "src/eval/**/*.test.ts",
      "src/server/**/*.test.ts",
      "src/app/**/*.test.ts",
      "src/lib/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ]);
    expect(unit.test?.exclude).toEqual([
      "src/services/camera/**",
      "scripts/kkm-catalog/**/*.test.mjs",
      "scripts/refresh-tire-meta.test.mjs",
      "scripts/boss-workbook-reconcile-dryrun.test.mjs",
      "scripts/boss-override-2026-08-05.test.mjs",
      "scripts/tire-db-repair/03_part_number_aliases.test.mjs",
      "scripts/tire-db-repair/09_promote_preflight.test.mjs",
      "scripts/tire-db-repair/10_promote_execute.test.mjs",
      "scripts/tire-db-repair/11_twin_columns.test.mjs",
      "scripts/tire-db-repair/model_styling.test.mjs",
      "scripts/tire-db-repair/validate.test.mjs",
    ]);

    expect(dom.test?.name).toBe("dom");
    expect(dom.test?.environment).toBe("jsdom");
    expect(dom.test?.include).toEqual([
      "src/components/**/*.test.tsx",
      "src/app/**/*.test.tsx",
      "src/stores/**/*.test.ts",
      "src/services/camera/**/*.test.ts",
    ]);
    expect(dom.test?.setupFiles).toEqual(["./vitest.setup.ts"]);
    expect(dom.test?.exclude).toBeUndefined();
  });
});
