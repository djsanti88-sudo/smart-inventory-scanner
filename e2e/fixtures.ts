import { test as base, expect } from "@playwright/test";

// Shared e2e default for GENERIC (non-tire) fixture specs. Phase 9 made the production scan category
// default to "tire", whose firewall routes non-tire fixtures (Coca-Cola, DeWalt, supplements...) to
// Needs Review instead of counting. This fixture seeds the persisted scan store so the category starts
// at "Not specialized" ("any") - mirroring the unit-test factory - so generic specs behave as before.
//
// Production DEFAULT_SETTINGS stays "tire": tire-specific specs (scan-category, tire-fields, firewall,
// tire bots) import "@playwright/test" directly and exercise the real default.
//
// NOTE: the settings below are inlined (not imported from src/stores/scanStore) on purpose - importing
// that module instantiates the persisted store, which touches `localStorage` and crashes in Node. Keep
// in sync with DEFAULT_SETTINGS; only `scanContext` differs ("any" here vs "tire" in production).
const PERSIST_KEY = "sis-scan-v1";
const PERSIST_VERSION = 6;

const GENERIC_SETTINGS = {
  businessId: "demo-business",
  aiLookupEnabled: false,
  primaryProvider: "mock",
  fallbackProvider: "mock",
  dailyLookupLimit: 25,
  dailyLookupCount: 0,
  lastResetDate: "1970-01-01",
  requireHumanApprovalForMerges: true,
  allowImageSuggestions: true,
  allowProductUrlSuggestions: true,
  scannerSubmitMode: "both",
  scannerDebounceMs: 80,
  enablePendingSyncQueue: true,
  enableIdempotentSync: true,
  autoSuggestUnknowns: false,
  autoAddDecodedProducts: true,
  decodeBudgetMs: 13000,
  autoCatalogLearningEnabled: true,
  autoVerifyConfidenceThreshold: 80,
  scanContext: "any", // <-- the only deliberate difference from production DEFAULT_SETTINGS ("tire")
  trustedSourceAutoVerifyEnabled: true,
  aiOnlyAutoVerifyAllowed: false,
};

const SEED = JSON.stringify({ state: { settings: GENERIC_SETTINGS }, version: PERSIST_VERSION });

// Seed only when storage is empty (the very first load): after the app writes its own state, the guard
// stops us from clobbering mid-test settings changes (e.g. enabling AI). Nothing in the app ever changes
// scanContext on its own, so it stays "any" for the whole run.
export const test = base.extend({
  // `run` is Playwright's fixture-use callback (named `run`, not `use`, so the react-hooks lint rule does
  // not mistake it for a React Hook). Playwright passes it positionally; the name is irrelevant.
  page: async ({ page }, run) => {
    await page.addInitScript(
      ({ key, seed }) => {
        try {
          if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, seed);
        } catch {
          // localStorage may be unavailable before the first real navigation; ignore.
        }
      },
      { key: PERSIST_KEY, seed: SEED },
    );
    await run(page);
  },
});

export { expect };
export type { Page, Route, Locator } from "@playwright/test";
