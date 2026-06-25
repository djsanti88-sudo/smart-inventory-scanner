import { describe, it, expect } from "vitest";
import { agreeOnSize, runSizeRace } from "./sizeRace";

describe("agreeOnSize - independent two-source size agreement", () => {
  it("true only when both sources land the same normalized size", () => {
    expect(agreeOnSize("265/70R17", "265/70R17")).toBe(true);
    expect(agreeOnSize("265/70 R17", "265/70R17")).toBe(true);
  });
  it("false on disagreement or a missing source", () => {
    expect(agreeOnSize("265/70R17", "235/75R17")).toBe(false);
    expect(agreeOnSize("265/70R17", "")).toBe(false);
    expect(agreeOnSize("", "")).toBe(false);
    expect(agreeOnSize(undefined, "265/70R17")).toBe(false);
  });
});

describe("runSizeRace", () => {
  it("sets sizeAgreement true when both roads return the same size, false otherwise", async () => {
    const agree = await runSizeRace({ armAGetSize: async () => "265/70R17", armBGetSize: async () => "265/70R17" });
    expect(agree.sizeAgreement).toBe(true);
    const disagree = await runSizeRace({ armAGetSize: async () => "265/70R17", armBGetSize: async () => "235/75R17" });
    expect(disagree.sizeAgreement).toBe(false);
    const single = await runSizeRace({ armAGetSize: async () => "265/70R17", armBGetSize: async () => "" });
    expect(single.sizeAgreement).toBe(false);
    expect(single.size).toBe("265/70R17");
  });
  it("an arm that throws does not crash the race", async () => {
    const r = await runSizeRace({ armAGetSize: async () => { throw new Error("boom"); }, armBGetSize: async () => "265/70R17" });
    expect(r.sizeAgreement).toBe(false);
    expect(r.size).toBe("265/70R17");
  });
});
