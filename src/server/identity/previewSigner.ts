import "server-only";

import type { PreviewSigner } from "@/services/identity/preview";
import { realmSafeBytes } from "@/services/identity/cryptoBytes";

const signatureDomain = "identity-preview-signature-v1:";
const base64Url = /^[A-Za-z0-9_-]+$/;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeSignature(value: string): Uint8Array | undefined {
  if (!base64Url.test(value) || value.length !== 43) return undefined;
  const decoded = new Uint8Array(Buffer.from(value, "base64url"));
  return decoded.byteLength === 32 && Buffer.from(decoded).toString("base64url") === value ? realmSafeBytes(decoded) : undefined;
}

/** Strictly decodes the server-owned local/mock HMAC material; malformed configuration fails closed. */
export function decodePreviewSigningKey(value: string | undefined): Uint8Array {
  if (!value || !base64Url.test(value)) throw new Error("local_preview_signing_key_unavailable");
  const decoded = new Uint8Array(Buffer.from(value, "base64url"));
  if (decoded.byteLength < 32 || Buffer.from(decoded).toString("base64url") !== value) {
    throw new Error("local_preview_signing_key_unavailable");
  }
  return realmSafeBytes(decoded);
}

/** HMAC signs a domain-separated canonical payload and never exposes the loaded key to a caller. */
export async function createLocalPreviewSigner(encodedKey: string | undefined): Promise<PreviewSigner> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    realmSafeBytes(decodePreviewSigningKey(encodedKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const payload = (canonicalPayload: string) => bytes(`${signatureDomain}${canonicalPayload}`);
  return {
    async sign(canonicalPayload) {
      return Buffer.from(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, realmSafeBytes(payload(canonicalPayload))))).toString("base64url");
    },
    async verify(canonicalPayload, signature) {
      const decoded = decodeSignature(signature);
      return decoded !== undefined && globalThis.crypto.subtle.verify("HMAC", key, realmSafeBytes(decoded), realmSafeBytes(payload(canonicalPayload)));
    },
  };
}
