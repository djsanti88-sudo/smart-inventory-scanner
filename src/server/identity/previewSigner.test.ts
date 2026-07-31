import { describe, expect, it } from "vitest";
import { createLocalPreviewSigner, decodePreviewSigningKey } from "./previewSigner";

const key = Buffer.alloc(32, 7).toString("base64url");

describe("local identity preview signer", () => {
  it("accepts only canonical unpadded base64url keys of at least 32 bytes", () => {
    expect(decodePreviewSigningKey(key)).toHaveLength(32);
    for (const invalid of ["short", `${key}=`, "+".repeat(43), "A".repeat(42)]) {
      expect(() => decodePreviewSigningKey(invalid)).toThrow("local_preview_signing_key_unavailable");
    }
  });

  it("domain-separates HMAC signatures and rejects malformed signatures", async () => {
    const signer = await createLocalPreviewSigner(key);
    const signature = await signer.sign('{"preview":true}');
    expect(await signer.verify('{"preview":true}', signature)).toBe(true);
    expect(await signer.verify('{"preview":false}', signature)).toBe(false);
    expect(await signer.verify('{"preview":true}', `${signature}=`)).toBe(false);
    expect(await signer.verify('{"preview":true}', Buffer.alloc(31).toString("base64url"))).toBe(false);
  });
});
