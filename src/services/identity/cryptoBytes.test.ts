import { describe, expect, it } from "vitest";
import { realmSafeBytes } from "./cryptoBytes";

describe("realmSafeBytes", () => {
  it("copies an ArrayBuffer into a current-realm owned Uint8Array", () => {
    const source = new Uint8Array([1, 2, 3]).buffer;
    const output = realmSafeBytes(source);
    expect([...output]).toEqual([1, 2, 3]);
    expect(output.buffer).not.toBe(source);
  });

  it("copies a sliced Node Buffer without exposing unrelated bytes", () => {
    const source = Buffer.from([8, 1, 2, 3, 9]).subarray(1, 4);
    expect([...realmSafeBytes(source)]).toEqual([1, 2, 3]);
  });
});
