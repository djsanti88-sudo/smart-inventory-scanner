import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  goUpcRung,
  evaluatePrefix,
  makeDefaultPrefixLookup,
  __resetArchiveCounter,
  type GoUpcRungDeps,
} from "@/server/upc/GoUpcProvider";
import type { GoUpcOutcome, GoUpcProduct } from "@/services/upc/goUpcClient";
import type { LadderStorage, MissEntry, UsageState, DecodeArchiveEntry } from "@/server/upc/storage";
import type { GoUpcUsage } from "@/server/upc/goUpcUsage";

// A real GTIN with a valid check digit (Falken Wildpeak from the 2026-07-08 run). Prefix 0929711 is
// Bridgestone family; 848983xxxxxx is Falken. We use codes with valid GS1 check digits so the gate lets
// them through - the gate is proven separately by the non-GTIN cases.
const FALKEN = "848983006257"; // valid UPC-A, Falken
const BRIDGESTONE_PREFIX = "092971135485"; // prefix 0929711 (Bridgestone owner), valid check digit
const CARLSTAR_PREFIX = "070964035646"; // prefix 0709640 (carlstar owner in general map), valid check digit
const UNKNOWN_PREFIX = "036000291452"; // real UPC-A, prefix not in any tire/brand map

// A pass-through gate stub: runs fn immediately, no spacing, no dedup complexity for these tests.
function passThroughGate() {
  return { run: <T>(_key: string, fn: () => Promise<T>) => fn() } as unknown as GoUpcRungDeps["gate"];
}

// In-memory LadderStorage with call spies.
function memStorage(seed?: { miss?: Record<string, MissEntry> }): LadderStorage & {
  archives: DecodeArchiveEntry[];
  missWrites: Array<{ key: string; entry: MissEntry }>;
} {
  const usage: UsageState = { month: "2026-07", used: 0 };
  const miss: Record<string, MissEntry> = { ...(seed?.miss ?? {}) };
  const archives: DecodeArchiveEntry[] = [];
  const missWrites: Array<{ key: string; entry: MissEntry }> = [];
  const kv = new Map<string, string>();
  return {
    archives,
    missWrites,
    readUsage: async () => usage,
    writeUsage: async (s) => {
      Object.assign(usage, s);
    },
    incrementUsage: async (month) => {
      const used = usage.month === month ? usage.used + 1 : 1;
      Object.assign(usage, { month, used });
      return used;
    },
    readMissCache: async (key) => miss[key] ?? null,
    writeMissCache: async (key, e) => {
      miss[key] = e;
      missWrites.push({ key, entry: e });
    },
    appendArchive: async (entry) => {
      archives.push(entry);
    },
    appendOutcome: async () => {
      // A4 ledger: not exercised by these Go-UPC rung tests; no-op stub keeps the fake LadderStorage
      // interface-complete after storage.ts added appendOutcome (Task 10/A4).
    },
    get: async (key) => kv.get(key) ?? null,
    set: async (key, value) => {
      kv.set(key, value);
    },
    increment: async (key) => {
      const n = Number(kv.get(key) ?? "0") + 1;
      kv.set(key, String(n));
      return n;
    },
  };
}

// Usage gate stub: allowed unless overridden, with a record() spy.
function usageGate(allowed = true): GoUpcUsage & { records: number } {
  let records = 0;
  return {
    get records() {
      return records;
    },
    canSpend: async () =>
      allowed
        ? { allowed: true, used: 0, limit: 4800, warn: false }
        : { allowed: false, used: 4800, limit: 4800, warn: true, reason: "cap" },
    record: async () => {
      records += 1;
    },
  } as GoUpcUsage & { records: number };
}

function product(over?: Partial<GoUpcProduct>): GoUpcProduct {
  return {
    name: "Falken Wildpeak A/T3W 265/70R17 115T Tire",
    brand: "Falken",
    description: "",
    imageUrl: "https://img.example/falken.jpg",
    category: "Tire",
    specs: [["Size", "265/70R17"]],
    ...over,
  };
}

function hit(over?: Partial<GoUpcProduct>, inferred = false): GoUpcOutcome {
  return { kind: "hit", inferred, product: product(over), raw: { product: product(over), inferred } };
}

// Base deps for a happy path; individual tests override pieces.
function baseDeps(over?: Partial<GoUpcRungDeps>): GoUpcRungDeps {
  return {
    apiKey: "testkey",
    client: vi.fn(async () => hit()),
    gate: passThroughGate(),
    usage: usageGate(),
    storage: memStorage(),
    prefixLookup: () => null, // unknown prefix by default
    now: () => new Date("2026-07-09T00:00:00.000Z"),
    archiveEvery: 1, // archive every hit in tests unless overridden
    ...over,
  };
}

beforeEach(() => __resetArchiveCounter());

describe("goUpcRung", () => {
  it("exact hit -> HONEST suggested decision (Go-UPC self-report, never verified) + archive appended + usage recorded", async () => {
    const storage = memStorage();
    const usage = usageGate();
    const deps = baseDeps({ storage, usage });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_exact");
    // D6/Task 2: Go-UPC is a raw paid-DB API self-report, never app-verified - demoted to "suggested".
    expect(r.decision?.status).toBe("suggested");
    expect(r.decision?.status).not.toBe("verified");
    expect(r.decision?.exactCodeEvidenceVerifiedByApp).toBe(false);
    expect(r.decision?.evidenceStrength).toBe("none");
    expect(r.decision?.evidenceStrength).not.toBe("fetched_source");
    // Confidence stays 0.9 - a settled suggestion still auto-applies to the counted row.
    expect(r.decision?.confidence).toBe(0.9);
    expect(r.results?.[0].brand).toBe("Falken");
    expect(r.results?.[0].verifiedFacts).toContain("Go-UPC exact barcode match");
    expect(storage.archives).toHaveLength(1);
    expect(storage.archives[0].provider).toBe("go-upc");
    expect(usage.records).toBe(1);
  });

  it("exact hit whose brand CONFLICTS with a known prefix owner -> prefix_conflict, NEVER verified", async () => {
    // prefix 0929711 owned by bridgestone family; Go-UPC says Westlake (the real 2026-07-08 error).
    const deps = baseDeps({
      client: vi.fn(async () => hit({ brand: "Westlake" })),
      prefixLookup: makeDefaultPrefixLookup({ "0929711": "bridgestone" }),
    });
    const r = await goUpcRung(BRIDGESTONE_PREFIX, deps);
    expect(r.path).toBe("goupc_prefix_conflict");
    expect(r.decision?.status).toBe("needs_review");
    expect(r.decision?.status).not.toBe("verified");
    expect(r.results?.[0].needsHumanReview).toBe(true);
  });

  it("carlstar-owned prefix + Go-UPC brand 'Carlisle' -> NO conflict (same company family); still HONEST suggested", async () => {
    // The eval false-positive: prefix owner carlstar vs Go-UPC Carlisle are the same company.
    const deps = baseDeps({
      client: vi.fn(async () => hit({ brand: "Carlisle" })),
      prefixLookup: makeDefaultPrefixLookup({ "0709640": "carlstar" }),
    });
    const r = await goUpcRung(CARLSTAR_PREFIX, deps);
    expect(r.path).toBe("goupc_exact");
    expect(r.decision?.status).toBe("suggested");
  });

  it("exact hit with an UNKNOWN prefix -> HONEST suggested normally (absence of prefix data never blocks)", async () => {
    const deps = baseDeps({
      client: vi.fn(async () => hit({ brand: "Westlake" })),
      prefixLookup: () => null,
    });
    const r = await goUpcRung(UNKNOWN_PREFIX, deps);
    expect(r.path).toBe("goupc_exact");
    expect(r.decision?.status).toBe("suggested");
  });

  it("inferred hit -> needs_review suggestion + archived + NO negative cache", async () => {
    const storage = memStorage();
    const deps = baseDeps({ storage, client: vi.fn(async () => hit({}, true)) });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_inferred");
    expect(r.decision?.status).toBe("needs_review");
    expect(r.results?.[0].needsHumanReview).toBe(true);
    expect(storage.archives).toHaveLength(1);
    expect(storage.missWrites).toHaveLength(0); // never negative-cache an inferred hit
  });

  it("miss -> 30d negative cache written with canonical GTIN key + falls through", async () => {
    const storage = memStorage();
    const deps = baseDeps({ storage, client: vi.fn(async () => ({ kind: "miss" }) as GoUpcOutcome) });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_miss");
    expect(storage.missWrites).toHaveLength(1);
    expect(storage.missWrites[0].entry.ttlDays).toBe(30);
    expect(storage.missWrites[0].key).toBe("00848983006257"); // canonicalGtin(FALKEN)
  });

  it("second call on a cached miss does NOT invoke the client within TTL", async () => {
    const canonical = "00848983006257";
    const storage = memStorage({
      miss: { [canonical]: { canonical, missedAt: "2026-07-01T00:00:00.000Z", ttlDays: 30 } },
    });
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ storage, client, now: () => new Date("2026-07-09T00:00:00.000Z") });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_miss");
    expect(client).not.toHaveBeenCalled();
  });

  it("expired TTL calls the client again", async () => {
    const canonical = "00848983006257";
    const storage = memStorage({
      miss: { [canonical]: { canonical, missedAt: "2026-05-01T00:00:00.000Z", ttlDays: 30 } },
    });
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ storage, client, now: () => new Date("2026-07-09T00:00:00.000Z") });
    const r = await goUpcRung(FALKEN, deps);
    expect(client).toHaveBeenCalledTimes(1);
    expect(r.path).toBe("goupc_exact");
  });

  it("cap reached -> goupc_unavailable, client NEVER called, reason 'Go-UPC monthly cap reached'", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ usage: usageGate(false), client });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_unavailable");
    expect(r.reason).toBe("Go-UPC monthly cap reached");
    expect(client).not.toHaveBeenCalled();
  });

  it("429 quota -> reason 'Go-UPC quota exhausted'", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "quota" }) as GoUpcOutcome) });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_unavailable");
    expect(r.reason).toBe("Go-UPC quota exhausted");
  });

  it("transient -> falls through (unavailable), NOT negative-cached", async () => {
    const storage = memStorage();
    const deps = baseDeps({
      storage,
      client: vi.fn(async () => ({ kind: "transient", detail: "AbortError" }) as GoUpcOutcome),
    });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_unavailable");
    expect(r.reason).toContain("transient");
    expect(storage.missWrites).toHaveLength(0);
  });

  it("missing key -> skipped with reason, client never called", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ apiKey: undefined, client });
    const r = await goUpcRung(FALKEN, deps);
    expect(r.path).toBe("goupc_unavailable");
    expect(r.reason).toBe("Go-UPC key not configured");
    expect(client).not.toHaveBeenCalled();
  });

  it("non-GTIN input -> goupc_miss 'not a GTIN / failed check digit', client never called", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ client });
    const r = await goUpcRung("DCB205", deps);
    expect(r.path).toBe("goupc_miss");
    expect(r.reason).toBe("not a GTIN / failed check digit");
    expect(client).not.toHaveBeenCalled();
  });

  it("GTIN-shaped but BAD check digit -> goupc_miss, client never called", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ client });
    const r = await goUpcRung("036000291453", deps); // last digit off by one
    expect(r.path).toBe("goupc_miss");
    expect(r.reason).toBe("not a GTIN / failed check digit");
    expect(client).not.toHaveBeenCalled();
  });

  it("archive every N: with archiveEvery=200 a single hit is NOT archived", async () => {
    const storage = memStorage();
    const deps = baseDeps({ storage, archiveEvery: 200 });
    await goUpcRung(FALKEN, deps);
    expect(storage.archives).toHaveLength(0);
  });
});

describe("evaluatePrefix (smart firewall)", () => {
  it("unknown owner -> no conflict", () => {
    expect(evaluatePrefix(BRIDGESTONE_PREFIX, "Westlake", { prefixLookup: () => null })).toEqual({
      owner: null,
      conflict: false,
    });
  });

  it("known owner + different brand + not same family -> conflict", () => {
    const v = evaluatePrefix(BRIDGESTONE_PREFIX, "Westlake", { prefixLookup: () => "bridgestone" });
    expect(v.conflict).toBe(true);
    expect(v.owner).toBe("bridgestone");
  });

  it("known owner + same-family brand -> no conflict", () => {
    expect(evaluatePrefix(BRIDGESTONE_PREFIX, "Firestone", { prefixLookup: () => "bridgestone" }).conflict).toBe(false);
    expect(evaluatePrefix(CARLSTAR_PREFIX, "Carlisle", { prefixLookup: () => "carlstar" }).conflict).toBe(false);
  });

  it("known owner + matching brand -> no conflict", () => {
    expect(evaluatePrefix(BRIDGESTONE_PREFIX, "Bridgestone", { prefixLookup: () => "bridgestone" }).conflict).toBe(false);
  });

  it("does not conflict when Go-UPC brand is a corporate sibling of the prefix owner (Michelin on bfgoodrich prefix)", () => {
    const v = evaluatePrefix("086699998538", "Michelin", { prefixLookup: () => "bfgoodrich" });
    expect(v.owner).toBe("bfgoodrich");
    expect(v.conflict).toBe(false);
  });

  it("still conflicts when the brand is NOT in the owner's family", () => {
    const v = evaluatePrefix("086699998538", "Goodyear", { prefixLookup: () => "bfgoodrich" });
    expect(v.conflict).toBe(true);
  });
});

describe("makeDefaultPrefixLookup", () => {
  it("consults the tire map first, then the general map, else null", () => {
    const lookup = makeDefaultPrefixLookup({ "0929711": "bridgestone" });
    expect(lookup("092971135485")).toBe("bridgestone");
    expect(lookup("0000000")).toBe(null); // too short
    expect(lookup("999888777666")).toBe(null); // unknown prefix
  });
});
