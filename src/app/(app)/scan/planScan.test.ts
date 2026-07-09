import { describe, it, expect } from "vitest";
import { planScanBatch } from "./planScan";

// planScanBatch decides whether a raw scan-input string is ONE code (even if it contains internal
// whitespace, e.g. a space-separated part number like "2881 6861") or a genuine multi-code bulk
// paste (several distinct codes separated by whitespace/newlines). It must never guess: it only
// treats the string as a single code when the whole trimmed string itself resolves as a known
// code via the caller-supplied resolver; otherwise it falls back to splitting on whitespace so
// legitimate bulk pastes still work.

describe("planScanBatch", () => {
  it("keeps a space-separated code as ONE scan when the whole string resolves", () => {
    const resolvesWhole = (code: string) => code === "2881 6861";
    const plan = planScanBatch("2881 6861", resolvesWhole);
    expect(plan).toEqual(["2881 6861"]);
  });

  it("splits into multiple scans when the whole string does NOT resolve but looks like a paste", () => {
    const resolvesWhole = () => false; // neither the whole string nor anything resolves in this fake
    const plan = planScanBatch("049000042566 012000001291", resolvesWhole);
    expect(plan).toEqual(["049000042566", "012000001291"]);
  });

  it("returns the single trimmed code unchanged when there is no whitespace at all", () => {
    const resolvesWhole = () => false;
    const plan = planScanBatch("848983012906", resolvesWhole);
    expect(plan).toEqual(["848983012906"]);
  });

  it("treats a run of whitespace as a delimiter when splitting (newlines, tabs, multiple spaces)", () => {
    const resolvesWhole = () => false;
    const plan = planScanBatch("111111111116\n222222222229\t333333333332", resolvesWhole);
    expect(plan).toEqual(["111111111116", "222222222229", "333333333332"]);
  });

  it("an empty/whitespace-only string yields no codes", () => {
    const resolvesWhole = () => false;
    expect(planScanBatch("   ", resolvesWhole)).toEqual([]);
    expect(planScanBatch("", resolvesWhole)).toEqual([]);
  });
});
