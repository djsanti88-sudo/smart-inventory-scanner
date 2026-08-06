import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseVercelEnvLs } from "./check-env-parity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Real `vercel env ls preview` output captured live 2026-08-06 against sharpenly/inventory
// (25+ vars present). Values are redacted to "Hidden" in the fixture - this checker only ever
// reads var NAMES and the `environments (git branch)` column, never a value, so redaction loses
// nothing this parser needs. This fixture is what caught the live defect: the modern Vercel CLI
// table has an extra `type` column (Sensitive/Non-sensitive) between `value` and
// `environments (git branch)` that the old 3-column parser did not account for, so it silently
// read 0 present vars against a project that actually has 25+.
const FIXTURE_PATH = path.join(__dirname, "check-env-parity.fixtures.preview.txt");

// The exact var-name set present for the Preview environment in the fixture (verified against
// the live capture: every row whose environments cell includes "Preview" as a whole token,
// including comma-joined multi-environment rows like "Preview, Production" and git-branch-suffixed
// rows like "Preview (codex/local-tire-demo)"). Duplicate names in the raw output (e.g.
// GO_UPC_MONTHLY_LIMIT and GPT_LADDER_DAILY_USD each appear twice) collapse to one entry in a Set.
const EXPECTED_PREVIEW_NAMES = new Set([
  "TRUSTED_EXACT_BOSS_BUSINESS_IDS",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GO_UPC_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT_JSON_BASE64",
  "FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_BACKEND",
  "NEXT_PUBLIC_AUTH_MODE",
  "BOSS_SHOP_CODE_ALIAS_BUSINESS_IDS",
  "GO_UPC_MONTHLY_LIMIT",
  "GPT_SEARCH_CONTEXT",
  "GPT_LADDER_DAILY_USD",
  "AI_LOOKUP_GLOBAL_BACKSTOP",
  "AI_LOOKUP_ACCOUNT_DAILY_LIMIT",
  "AI_LOOKUP_DAILY_LIMIT",
  "MASTER_CATALOG_APPEND",
  "AUTONOMA_SECRET_ID",
  "AUTONOMA_CLIENT_ID",
  "FIRECRAWL_API_KEY_7",
  "FIRECRAWL_API_KEY_6",
  "FIRECRAWL_API_KEY_5",
  "FIRECRAWL_API_KEY_4",
  "FIRECRAWL_API_KEY_3",
  "FIRECRAWL_API_KEY_2",
  "FIRECRAWL_API_KEY_1",
  "BRAVE_SEARCH_API_KEY",
  "OPENAI_FAST_MODEL",
  "ENABLE_LIVE_AI_LOOKUP",
  "FIRECRAWL_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_MODEL",
  "AI_PROVIDER",
  "GEMINI_API_KEY",
]);

describe("parseVercelEnvLs", () => {
  it("extracts the full real var-name set from a live modern `vercel env ls preview` table", () => {
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    const present = parseVercelEnvLs(fixture, "preview");

    expect(present.size).toBe(EXPECTED_PREVIEW_NAMES.size);
    for (const name of EXPECTED_PREVIEW_NAMES) {
      expect(present.has(name)).toBe(true);
    }
    // Regression guard for the exact defect observed live: TRUSTED_EXACT_BOSS_BUSINESS_IDS was
    // present in Preview but invisible to the parity gate because of this parser bug.
    expect(present.has("TRUSTED_EXACT_BOSS_BUSINESS_IDS")).toBe(true);
  });

  it("does not match a var scoped only to Production against a Preview query", () => {
    const stdout = [
      " name                          value      type            environments (git branch)     created",
      " PROD_ONLY_VAR                 Hidden     Sensitive       Production                     1d ago",
    ].join("\n");

    const present = parseVercelEnvLs(stdout, "preview");
    expect(present.has("PROD_ONLY_VAR")).toBe(false);
  });

  it("matches a var scoped to multiple environments via a comma-joined cell", () => {
    const stdout = [
      " name                          value      type            environments (git branch)     created",
      " SHARED_VAR                    Hidden     Sensitive       Preview, Production            1d ago",
    ].join("\n");

    const present = parseVercelEnvLs(stdout, "preview");
    expect(present.has("SHARED_VAR")).toBe(true);
  });

  it("matches a var whose environments cell carries a git-branch suffix", () => {
    const stdout = [
      " name                          value      type            environments (git branch)     created",
      " BRANCH_SCOPED_VAR             Hidden     Non-sensitive   Preview (codex/local-tire-demo)     4d ago",
    ].join("\n");

    const present = parseVercelEnvLs(stdout, "preview");
    expect(present.has("BRANCH_SCOPED_VAR")).toBe(true);
  });
});
