import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();
export function createReceipt(payload) { const receipt = { schemaVersion: "2.0.0", target: "localhost-synthetic-emulator", ...payload }; return { ...receipt, selfHash: hash(JSON.stringify(receipt)) }; }
export function verifyReceipt(receipt) { const { selfHash, ...rest } = receipt ?? {}; if (selfHash !== hash(JSON.stringify(rest))) throw new Error("Receipt self-hash validation failed."); }
export const redactedCode = (code) => hash(code).slice(0, 16);
