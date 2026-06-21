import { describe, it, expect } from "vitest";
import { parseServiceAccountJson, serviceAccountJsonFromEnv } from "./serviceAccount";

// A clearly-FAKE service account (placeholder strings, not a real key) used only to exercise parsing.
const FAKE = {
  project_id: "demo-smart-inventory",
  client_email: "sa@demo-smart-inventory.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nLINE1\\nLINE2\\n-----END PRIVATE KEY-----\\n",
};

describe("parseServiceAccountJson", () => {
  it("parses valid JSON and maps snake_case keys to the admin credential shape", () => {
    const sa = parseServiceAccountJson(JSON.stringify(FAKE));
    expect(sa.projectId).toBe("demo-smart-inventory");
    expect(sa.clientEmail).toBe("sa@demo-smart-inventory.iam.gserviceaccount.com");
  });

  it('normalizes escaped "\\n" newlines in private_key to real newlines', () => {
    const sa = parseServiceAccountJson(JSON.stringify(FAKE));
    expect(sa.privateKey).toContain("\n");
    expect(sa.privateKey).not.toContain("\\n");
    expect(sa.privateKey.split("\n").length).toBeGreaterThan(2);
  });

  it("throws a redacted error on invalid JSON (no secret contents in message)", () => {
    expect(() => parseServiceAccountJson("{not valid json")).toThrowError(/not valid JSON/);
  });

  it("throws listing the missing field names, without leaking any value", () => {
    const partial = JSON.stringify({ project_id: "x" });
    expect(() => parseServiceAccountJson(partial)).toThrowError(
      /missing required field\(s\): client_email, private_key/,
    );
  });
});

describe("serviceAccountJsonFromEnv", () => {
  it("returns the direct FIREBASE_SERVICE_ACCOUNT_JSON env var when set", () => {
    const raw = '{"project_id":"x"}';
    expect(serviceAccountJsonFromEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: raw })).toBe(raw);
  });

  it("decodes the FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 fallback", () => {
    const json = '{"project_id":"x"}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    expect(serviceAccountJsonFromEnv({ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: b64 })).toBe(json);
  });

  it("returns undefined when neither env var is set (callers fall back to file path / ADC)", () => {
    expect(serviceAccountJsonFromEnv({})).toBeUndefined();
  });
});
