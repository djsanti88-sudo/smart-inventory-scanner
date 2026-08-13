import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

export function isCompletePreviewCleanup(cleanup) {
  return Boolean(cleanup?.attempted) && cleanup.complete === true && Number.isInteger(cleanup.expectedDeleted) && cleanup.expectedDeleted > 0 && cleanup.deleted === cleanup.expectedDeleted && cleanup.postcheckRemaining === 0;
}

export function redactPreviewFailure(error) {
  return String(error?.message ?? error ?? "preview certification failure")
    .replace(/https:\/\/[^\s)]+/g, "[redacted-preview-url]")
    .replace(/(?:[A-Za-z0-9_-]{20,})/g, "[redacted-token]")
    .replace(/\d{8,}/g, "[masked-code]")
    .slice(0, 240);
}

export function createPreviewReceipt({ status, manifest, targetHost, cleanup, failures = [], ...rest }) {
  const digest = String(manifest?.contentDigest ?? "");
  const targetHash = hash(String(targetHost ?? ""));
  const expectedDeleted = Number(cleanup?.expectedDeleted ?? NaN);
  const receipt = {
    ...rest,
    schemaVersion: "1.0.0",
    target: "preview",
    status,
    targetHost: targetHash,
    manifest: { contentDigest: digest },
    cleanup: {
      attempted: Boolean(cleanup?.attempted), complete: Boolean(cleanup?.complete),
      expectedDeleted, deleted: Number(cleanup?.deleted ?? NaN), postcheckRemaining: Number(cleanup?.postcheckRemaining ?? NaN),
    },
    failures: failures.map(redactPreviewFailure),
  };
  return { ...receipt, selfHash: hash(JSON.stringify(receipt)) };
}

export function verifyPreviewReceipt(receipt) {
  const { selfHash, ...rest } = receipt ?? {};
  if (typeof selfHash !== "string" || selfHash !== hash(JSON.stringify(rest))) throw new Error("Preview receipt self-hash validation failed.");
  if (receipt.target !== "preview") throw new Error("Preview receipt target is invalid.");
  if (!/^boss-preview-[a-z0-9-]{16,64}-\d{3}$/.test(String(receipt.runId ?? ""))) throw new Error("Preview receipt run id is invalid.");
  if (!/^[A-F\d]{64}$/i.test(String(receipt.manifest?.contentDigest ?? ""))) throw new Error("Preview receipt manifest digest is invalid.");
  if (!/^[A-F\d]{64}$/i.test(String(receipt.targetHost ?? ""))) throw new Error("Preview receipt target hash is invalid.");
  const cleanup = receipt.cleanup;
  if (receipt.status === "passed" && !isCompletePreviewCleanup(cleanup)) {
    throw new Error("Preview certification cannot pass before complete, postchecked cleanup.");
  }
}
