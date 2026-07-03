import { describe, it, expect } from "vitest";
import { isValidPinFormat, hashPin, verifyPin } from "@/services/security/pinLock";

describe("pinLock", () => {
  it("accepts 4-6 digit PINs, rejects everything else", () => {
    expect(isValidPinFormat("1234")).toBe(true);
    expect(isValidPinFormat("123456")).toBe(true);
    expect(isValidPinFormat("123")).toBe(false); // too short
    expect(isValidPinFormat("1234567")).toBe(false); // too long
    expect(isValidPinFormat("12a4")).toBe(false); // non-digit
    expect(isValidPinFormat("")).toBe(false);
  });

  it("hashes the PIN (never returns the plaintext) and is stable", async () => {
    const h = await hashPin("1234");
    expect(h).not.toContain("1234");
    expect(h).toHaveLength(64); // sha-256 hex
    expect(await hashPin("1234")).toBe(h); // deterministic
    expect(await hashPin("4321")).not.toBe(h); // different PIN -> different hash
  });

  it("verifyPin accepts the right PIN and rejects wrong / empty", async () => {
    const h = await hashPin("246810");
    expect(await verifyPin("246810", h)).toBe(true);
    expect(await verifyPin("000000", h)).toBe(false);
    expect(await verifyPin("246810", "")).toBe(false); // no PIN set
    expect(await verifyPin("", h)).toBe(false);
  });
});
