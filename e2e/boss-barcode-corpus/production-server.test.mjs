import assert from "node:assert/strict";
import test from "node:test";
import { certificationEnvironment, sameCertifiedEnvironment } from "./production-server.mjs";
test("certification build and start environment match and scrub provider/Turso credentials", () => {
  const env = certificationEnvironment({ OPENAI_API_KEY: "secret", TURSO_AUTH_TOKEN: "secret", KEEP: "yes" });
  assert.equal(env.OPENAI_API_KEY, ""); assert.equal(env.TURSO_AUTH_TOKEN, ""); assert.equal(env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8080"); assert.equal(env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL, "http://127.0.0.1:9099"); assert.equal(sameCertifiedEnvironment(env, { ...env }), true); assert.equal(sameCertifiedEnvironment(env, { ...env, OPENAI_API_KEY: "secret" }), false);
});
