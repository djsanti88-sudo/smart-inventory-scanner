import { describe, it, expect, vi } from "vitest";
import { openFoodFactsRung, type OpenFoodFactsRungDeps } from "@/server/upc/OpenFoodFactsProvider";
import type { OpenFoodFactsOutcome, OpenFoodFactsProduct } from "@/services/upc/openFoodFactsClient";
import type { OpenFoodFactsUsage } from "@/server/upc/openFoodFactsUsage";

const YOGURT = "3017620422003"; // valid EAN-13 (real Nutella barcode, valid GS1 check digit)

function product(over?: Partial<OpenFoodFactsProduct>): OpenFoodFactsProduct {
  return {
    name: "Danone Activia Yogurt",
    brand: "Danone",
    category: "dairies",
    ...over,
  };
}

function hit(over?: Partial<OpenFoodFactsProduct>): OpenFoodFactsOutcome {
  return { kind: "hit", product: product(over), raw: { status: 1, product: product(over) } };
}

function usageGate(allowed = true): OpenFoodFactsUsage & { records: number } {
  let records = 0;
  return {
    get records() {
      return records;
    },
    canSpend: async () =>
      allowed
        ? { allowed: true, used: 0, limit: 10 }
        : { allowed: false, used: 10, limit: 10, reason: "Open Food Facts local per-minute limit reached (10/10 for 2026-07-12T12:34)" },
    record: async () => {
      records += 1;
    },
  } as OpenFoodFactsUsage & { records: number };
}

function baseDeps(over?: Partial<OpenFoodFactsRungDeps>): OpenFoodFactsRungDeps {
  return {
    client: vi.fn(async () => hit()),
    usage: usageGate(),
    now: () => new Date("2026-07-12T12:34:00.000Z"),
    ...over,
  };
}

describe("openFoodFactsRung", () => {
  it("hit -> settled SUGGESTION (confidence exactly 0.6, exactCodeEvidence NOT app-verified), usage recorded", async () => {
    const usage = usageGate();
    const deps = baseDeps({ usage });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_hit");
    expect(r.decision?.status).toBe("needs_review");
    expect(r.decision?.confidence).toBe(0.6);
    expect(r.decision?.exactCodeEvidenceVerifiedByApp).toBe(false);
    expect(r.results?.[0].brand).toBe("Danone");
    expect(r.results?.[0].needsHumanReview).toBe(true);
    expect(r.results?.[0].confidence).toBe(0.6);
    expect(usage.records).toBe(1);
  });

  it("miss -> unsettled 'openfoodfacts: no match'", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "miss" }) as OpenFoodFactsOutcome) });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_miss");
    expect(r.reason).toBe("openfoodfacts: no match");
    expect(r.decision).toBeUndefined();
  });

  it("local per-minute throttle reached -> unsettled, client NEVER called", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ usage: usageGate(false), client });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_unavailable");
    expect(r.reason.toLowerCase()).toContain("per-minute limit");
    expect(client).not.toHaveBeenCalled();
  });

  it("timeout/transient -> unsettled, reason mentions transient detail, never throws", async () => {
    const deps = baseDeps({
      client: vi.fn(async () => ({ kind: "transient", detail: "AbortError: aborted" }) as OpenFoodFactsOutcome),
    });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_unavailable");
    expect(r.reason).toContain("transient");
  });

  it("malformed JSON (surfaced as transient by the client) -> unsettled, no throw", async () => {
    const deps = baseDeps({
      client: vi.fn(async () => ({ kind: "transient", detail: "malformed JSON: Unexpected token" }) as OpenFoodFactsOutcome),
    });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_unavailable");
    expect(r.reason).toContain("malformed JSON");
  });

  it("429 quota from provider -> unsettled 'openfoodfacts: provider quota exhausted'", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "quota" }) as OpenFoodFactsOutcome) });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_unavailable");
    expect(r.reason).toBe("openfoodfacts: provider quota exhausted");
  });

  it("bad_format -> unsettled, not a hard fail", async () => {
    const deps = baseDeps({ client: vi.fn(async () => ({ kind: "bad_format" }) as OpenFoodFactsOutcome) });
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.path).toBe("openfoodfacts_unavailable");
  });

  it("non-GTIN input -> miss, client never called (defense in depth; buildLadderRungs also gates this)", async () => {
    const client = vi.fn(async () => hit());
    const deps = baseDeps({ client });
    const r = await openFoodFactsRung("X004DY7YUT", deps);
    expect(r.path).toBe("openfoodfacts_miss");
    expect(client).not.toHaveBeenCalled();
  });

  it("a hit NEVER produces a verified decision on its own (Resolver Trust Rules: single free source is a suggestion only)", async () => {
    const deps = baseDeps();
    const r = await openFoodFactsRung(YOGURT, deps);
    expect(r.decision?.status).not.toBe("verified");
  });
});
