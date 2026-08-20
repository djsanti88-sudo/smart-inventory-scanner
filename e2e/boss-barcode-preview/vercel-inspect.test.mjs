import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVercelInspectMetadata } from "./vercel-inspect.mjs";

test("normalizes complete legacy nested-project inspect identity", () => {
  assert.deepEqual(normalizeVercelInspectMetadata({ deployment: { url: "https://preview.vercel.app/", target: "preview", readyState: "READY" }, project: { id: "prj_1" } }), { url: "https://preview.vercel.app", target: "preview", readyState: "READY", projectId: "prj_1" });
  assert.throws(() => normalizeVercelInspectMetadata({ url: "https://preview.vercel.app" }), /identity/i);
});

test("CLI 58 top-level inspect identity binds its name to the trusted local project before attaching its id", () => {
  const cli58 = { id: "dpl_1", name: "inventory", url: "preview.vercel.app", target: "preview", readyState: "READY" };
  assert.deepEqual(
    normalizeVercelInspectMetadata(cli58, { projectId: "prj_trusted", projectName: "inventory" }),
    { url: "https://preview.vercel.app", target: "preview", readyState: "READY", projectId: "prj_trusted" },
  );
  assert.throws(() => normalizeVercelInspectMetadata(cli58, { projectId: "prj_attacker", projectName: "other" }), /identity/i);
  assert.throws(() => normalizeVercelInspectMetadata({ ...cli58, name: "" }, { projectId: "prj_trusted", projectName: "inventory" }), /identity/i);
  assert.throws(() => normalizeVercelInspectMetadata({ ...cli58, url: "preview.vercel.app/path" }, { projectId: "prj_trusted", projectName: "inventory" }), /identity/i);
});
