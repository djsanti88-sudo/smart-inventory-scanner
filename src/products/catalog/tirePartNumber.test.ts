import { describe, it, expect } from "vitest";
import { basePartNumberKey, tirePartNumberCore, tirePartNumberVariants } from "./tirePartNumber";

describe("basePartNumberKey", () => {
  it("strips spaces and hyphens and uppercases", () => {
    expect(basePartNumberKey(" f-28034300 ")).toBe("F28034300");
    expect(basePartNumberKey("215-55-16 ACCELERA")).toBe("2155516ACCELERA");
  });
  it("empty-ish input -> empty string", () => {
    expect(basePartNumberKey("")).toBe("");
    expect(basePartNumberKey(undefined as unknown as string)).toBe("");
  });
});

describe("tirePartNumberCore", () => {
  it("strips a leading distributor affix", () => {
    expect(tirePartNumberCore("BH762590")).toBe("762590");
    expect(tirePartNumberCore("GY706069165")).toBe("706069165");
    expect(tirePartNumberCore("MICH-97614")).toBe("97614");
    expect(tirePartNumberCore("KH2289933")).toBe("2289933");
    expect(tirePartNumberCore("F-28034300")).toBe("28034300");
  });
  it("strips a trailing distributor affix", () => {
    expect(tirePartNumberCore("762590BH")).toBe("762590");
    expect(tirePartNumberCore("18773NXK")).toBe("18773");
  });
  it("returns null for a pure-digit code (core equals base, nothing gained)", () => {
    expect(tirePartNumberCore("90000027117")).toBeNull();
    expect(tirePartNumberCore("036000291452")).toBeNull();
  });
  it("returns null when no >=5-digit block exists", () => {
    expect(tirePartNumberCore("ATRT02")).toBeNull();
    expect(tirePartNumberCore("TVPRT22N")).toBeNull();
  });
});

describe("tirePartNumberVariants", () => {
  it("affixed code -> [base, core]", () => {
    expect(tirePartNumberVariants("BH762590")).toEqual(["BH762590", "762590"]);
    expect(tirePartNumberVariants("762590BH")).toEqual(["762590BH", "762590"]);
  });
  it("pure-digit code -> [base] only", () => {
    expect(tirePartNumberVariants("90000027117")).toEqual(["90000027117"]);
  });
  it("blank -> []", () => {
    expect(tirePartNumberVariants("  ")).toEqual([]);
  });
});
