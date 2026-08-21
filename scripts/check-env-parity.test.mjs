import { describe, expect, it } from "vitest";
import { parseVercelEnvLs } from "./check-env-parity.mjs";

describe("parseVercelEnvLs", () => {
  it("parses the modern Vercel table including its type column", () => {
    const stdout = [
      " name                    value      type            environments (git branch)     created",
      " OPENAI_API_KEY          Hidden     Sensitive       Preview, Production            1d ago",
      " GPT_DECODE_DAILY_USD    Hidden     Non-sensitive   Preview (fix/simple)            1d ago",
      " PROD_ONLY_VAR           Hidden     Sensitive       Production                     1d ago",
    ].join("\n");

    const present = parseVercelEnvLs(stdout, "preview");
    expect([...present].sort()).toEqual(["GPT_DECODE_DAILY_USD", "OPENAI_API_KEY"]);
  });

  it("does not match a variable scoped only to another environment", () => {
    const stdout = [
      " name             value      type        environments (git branch)     created",
      " PROD_ONLY_VAR    Hidden     Sensitive   Production                     1d ago",
    ].join("\n");

    expect(parseVercelEnvLs(stdout, "preview").has("PROD_ONLY_VAR")).toBe(false);
  });
});
