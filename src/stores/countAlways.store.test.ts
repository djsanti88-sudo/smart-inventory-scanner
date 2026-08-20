import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";

function totalCount(store: ReturnType<typeof createTestScanStore>) {
  return store.getState().finalCounts.reduce((n, c) => n + c.quantity, 0);
}

describe("ensureProvisionalCount is idempotent", () => {
  it("counts an unresolved code exactly once even if invoked twice", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // A scan feed row must exist for the code (processScan normally makes it).
    store.getState().processScan("111111111116");
    // Two direct invocations of the primitive must yield EXACTLY ONE count, never two.
    // (Asserted as an absolute value so this test is self-contained in Task 1 — it does not
    // depend on processScan counting synchronously, which is Task 2's job. Still holds after
    // Task 2: processScan would count it to 1, then both calls below are idempotent no-ops.)
    store.getState().ensureProvisionalCount("111111111116", "test");
    store.getState().ensureProvisionalCount("111111111116", "test");
    expect(totalCount(store)).toBe(1);
  });
});

describe("every scan counts synchronously, regardless of lookup state", () => {
  it("counts an unknown scan when AI is OFF", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("222222222229");
    expect(totalCount(store)).toBe(1);
  });

  it("counts an unknown scan when OFFLINE", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ openaiConfigured: true, missingKeys: [] });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().setOnline(false);
    store.getState().processScan("333333333332");
    expect(totalCount(store)).toBe(1);
  });

  it("counts an unknown scan when the circuit breaker is OPEN", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().setAiStatus({ openaiConfigured: true, emergencyStop: true });
    store.getState().updateSettings({ aiLookupEnabled: true });
    store.getState().processScan("444444444445");
    expect(totalCount(store)).toBe(1);
  });

  it("re-scanning the same unknown code increments the SAME row (count 2, one product)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    store.getState().processScan("555555555558");
    store.getState().processScan("555555555558");
    expect(totalCount(store)).toBe(2);
    expect(store.getState().finalCounts.length).toBe(1);
  });
});

// The owner's real 174-code batch (173 UPC-A + 1 EAN-13), all unique, none in the seed catalog.
// With AI off, every unresolved scan counts synchronously — proving "scan 174 = count 174"
// independent of any decode, breaker, cap, or network.
const CODES_174 = `697662129691 697662131854 697662137658 697662133469 697662126256 697662129325 697662128489 697662131007 697662124627 697662099659 697662099673 697662099734 697662099789 697662099796 697662099802 697662099819 697662099826 697662099895 697662101550 697662101611 697662102885 697662103042 697662117612 697662099598 697662099604 697662099628 697662099642 697662099727 697662099741 697662099833 697662099864 697662099871 697662099901 697662101567 697662114208 697662116592 697662117650 697662117698 697662135708 5452000649706 697662087694 697662096580 697662099581 697662099611 697662099758 086699368492 086699077691 086699087829 086699159991 086699224750 086699232816 086699258427 086699315670 086699373304 086699428301 086699473608 086699042132 086699051462 086699060099 086699117120 086699137685 086699143921 086699152176 086699165459 086699212016 086699236098 086699300546 086699332844 086699339157 086699397317 086699430304 086699431998 086699525222 086699624710 086699679611 086699778642 086699835338 086699855275 086699880628 086699979674 086699998538 086699014313 086699034588 086699061348 086699146441 086699146878 086699182692 086699188540 086699202130 086699202819 715459275427 715459286782 715459288922 715459268832 715459268849 715459271962 715459276622 715459279173 715459279180 715459279623 715459279647 715459286775 715459290635 715459303878 715459304158 715459305315 715459305353 715459343911 715459248278 715459268962 715459279050 715459279166 715459288915 715459332915 715459343652 715459220038 715459230815 715459260041 715459268900 715459268948 715459269006 715459271931 715459271948 715459271979 715459273683 715459286256 715459286768 715459288946 715459290963 715459302802 715459305490 715459313648 715459328529 715459343799 715459361816 715459309115 715459258581 715459268788 715459284375 715459305339 715459309047 715459309160 715459313631 715459317998 715459322428 715459342297 715459342334 715459258901 715459262281 715459305346 715459308996 715459309061 715459309078 715459309122 715459309177 715459313686 715459318001 715459319565 715459322404 715459241538 715459298297 715459305377 715459305414 715459306954 715459308620 715459308972 715459309023 715459309108 715459309139 715459309146 715459309184 715459309337 715459313624 715459313655`.trim().split(/\s+/);

describe("174-code burst always counts 174 (owner acceptance)", () => {
  it("counts every one of the 174 unique codes with AI off (all synchronous)", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.getState().updateSettings({ aiLookupEnabled: false });
    for (const code of CODES_174) store.getState().processScan(code);
    expect(CODES_174.length).toBe(174);
    expect(totalCount(store)).toBe(174);
    expect(store.getState().finalCounts.length).toBe(174); // 174 unique codes -> 174 rows, no collisions
  });
});
