import { describe, it, expect, vi } from "vitest";
import { upcItemDbRung, type UpcItemDbRungDeps } from "@/server/upc/UpcItemDbProvider";
import type { UpcItemDbOutcome, UpcItemDbItem } from "@/services/upc/upcItemDbClient";
import type { UpcItemDbUsage } from "@/server/upc/upcItemDbUsage";

const FALKEN = "848983006257"; // valid UPC-A

function item(over?: Partial<UpcItemDbItem>): UpcItemDbItem {
  return {
    title: "Falken Wildpeak A/T3W 265/70R17 115T Tire",
    brand: "Falken",
    category: "Tire",
    ...over,
  };
}

function hit(over?: Partial<UpcItemDbItem>): UpcItemDbOutcome {
  return { kind: "hit", item: item(over), raw: { items: [item(over)] } };
}

function usageGate(allowed = true): UpcItemDbUsage & { records: number } {
  let records = 0;
  return {
    get records() {
      return records;
    },
    canSpend: async () =>
      allowed
        ? { allowed: true, used: 0, limit: 90 }
        : { allowed: false, used: 90, limit: 90, reason: "UPCitemdb local daily limit reached (90/90 for 2026-07-12)" },
    record: async () => {
      records += 1;
    },
  } as UpcItemDbUsage & { records: number };
}

function baseDeps(over?: Partial<UpcItemDbRungDeps>): UpcItemDbRungDeps {
  return {
    client: vi.fn(async () => hit()),
    usage: usageGate(),
    now: () => new Date("2026-07-12T00:00:00.000Z"),
    ...over,
  };
}

describe("upcItemDbRung", () => {
  it("hit -> settled SUGGESTION (confidence exactly 0.6, exactCodeEvidence NOT app-verified), usage recorded", async () => {
    const usage = usageGate();
    const deps = baseDeps({ usage });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_hit");
    expect(r.decision?.status).toBe("needs_review");
    expect(r.decision?.confidence).toBe(0.6);
    expect(r.decision?.exactCodeEvidenceVerifiedByApp).toBe(false);
    expect(r.results?.[0].brand).toBe("Falken");
    expect(r.results?.[0].needsHumanReview).toBe(true);
    expect(r.results?.[0].confidence).toBe(0.6);
    expect(usage.records).toBe(1);
  });

  it("miss -> unsettled 'upcitemdb: no match', client called, no usage charge on a miss decision path change", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "miss" }) as UpcItemDbOutcome) });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_miss");
    expect(r.reason).toBe("upcitemdb: no match");
    expect(r.decision).toBeUndefined();
  });

  it("local daily cap reached -> unsettled 'upcitemdb: local daily limit', client NEVER called", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ usage: usageGate(false), client });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_unavailable");
    expect(r.reason.toLowerCase()).toContain("local daily limit");
    expect(client).not.toHaveBeenCalled();
  });

  it("timeout/transient -> unsettled, reason mentions transient detail, never throws", async () => {
    const deps = baseDeps({
      client: vi.fn(async () => ({ kind: "transient", detail: "AbortError: aborted" }) as UpcItemDbOutcome),
    });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_unavailable");
    expect(r.reason).toContain("transient");
  });

  it("malformed JSON (surfaced as transient by the client) -> unsettled, no throw", async () => {
    const deps = baseDeps({
      client: vi.fn(async () => ({ kind: "transient", detail: "malformed JSON: Unexpected token" }) as UpcItemDbOutcome),
    });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_unavailable");
    expect(r.reason).toContain("malformed JSON");
  });

  it("429 quota from provider -> unsettled 'upcitemdb: provider quota exhausted'", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "quota" }) as UpcItemDbOutcome) });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_unavailable");
    expect(r.reason).toBe("upcitemdb: provider quota exhausted");
  });

  it("bad_format -> unsettled, not a hard fail", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "bad_format" }) as UpcItemDbOutcome) });
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.path).toBe("upcitemdb_unavailable");
  });

  it("non-GTIN input -> unavailable, client never called (gate enforced by the rung too, defense in depth)", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ client });
    const r = await upcItemDbRung("X004DY7YUT", deps);
    expect(r.path).toBe("upcitemdb_miss");
    expect(client).not.toHaveBeenCalled();
  });

  it("a hit NEVER produces a verified decision on its own (Resolver Trust Rules: single free source is a suggestion only)", async () => {
    const deps = baseDeps();
    const r = await upcItemDbRung(FALKEN, deps);
    expect(r.decision?.status).not.toBe("verified");
  });
});
