import { createHmac } from "node:crypto";

const RECEIPT_KEY_NAME = "BOSS_CERT_RECEIPT_HMAC_KEY";
const MIN_HMAC_KEY_BYTES = 16;

export function requireReceiptHmacKey(key = process.env[RECEIPT_KEY_NAME]) {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < MIN_HMAC_KEY_BYTES) {
    throw new Error(`${RECEIPT_KEY_NAME} must be set to a private HMAC key of at least ${MIN_HMAC_KEY_BYTES} bytes for corpus-proof receipts.`);
  }
  return key;
}

function hmac(domain, value, key) {
  return createHmac("sha256", requireReceiptHmacKey(key)).update(`${domain}\0${value}`, "utf8").digest("hex").toUpperCase();
}

/** A non-reversible receipt identifier. The domain prevents reuse as an index lookup digest. */
export function redactedCode(code, key) {
  return hmac("scanbin/boss-cert/v1/receipt-identifier", String(code), key).slice(0, 32);
}

export function createReceipt(payload, key) {
  const receipt = { schemaVersion: "3.0.0", target: "localhost-synthetic-emulator", ...payload };
  return { ...receipt, selfHash: hmac("scanbin/boss-cert/v1/receipt-integrity", JSON.stringify(receipt), key) };
}

export function verifyReceipt(receipt, key) {
  const { selfHash, ...rest } = receipt ?? {};
  if (selfHash !== hmac("scanbin/boss-cert/v1/receipt-integrity", JSON.stringify(rest), key)) throw new Error("Receipt self-hash validation failed.");
}
