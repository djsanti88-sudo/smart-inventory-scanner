import { describe, it, expect } from "vitest";
import { evaluateMismatch, inferDomain } from "./productMismatchGuard";

describe("inferDomain", () => {
  it("detects tire and tobacco domains", () => {
    expect(inferDomain({ name: "Falken Sincera ST80", category: "Tire" })).toBe("tire");
    expect(inferDomain({ name: "Camel Crush Menthol Silver Cigarettes" })).toBe("tobacco");
    expect(inferDomain({ name: "Mystery Thing" })).toBeNull();
  });
});

describe("evaluateMismatch", () => {
  it("HIGH RISK: a Falken tire code linked to Camel cigarettes (the real bug)", () => {
    const v = evaluateMismatch({
      scannedCode: "2881-6861",
      suggested: { name: "Falken Sincera ST80", brand: "Falken", category: "Tire" },
      target: { name: "Camel Crush Menthol Silver Cigarettes", brand: "Camel", category: "Cigarettes" },
    });
    expect(v.risk).toBe("high_risk");
    expect(v.reason).toBe("domain_mismatch");
    expect(v.suggestedDomain).toBe("tire");
    expect(v.targetDomain).toBe("tobacco");
    expect(v.message).toMatch(/Falken|tire/i);
  });

  it("SAFE: linking a tire code to the same tire product", () => {
    const v = evaluateMismatch({
      scannedCode: "2881-6861",
      suggested: { name: "Falken Sincera ST80", brand: "Falken", category: "Tire" },
      target: { name: "Falken Sincera ST80 A/S", brand: "Falken", category: "Tire" },
    });
    expect(v.risk).toBe("safe");
  });

  it("WARN: same/unknown domain but a clearly different brand", () => {
    const v = evaluateMismatch({
      scannedCode: "ABC123",
      suggested: { name: "Generic Widget", brand: "Acme" },
      target: { name: "Other Widget", brand: "Globex" },
    });
    expect(v.risk).toBe("warn");
    expect(v.reason).toBe("brand_mismatch");
  });

  it("SAFE when there is no suggestion to compare against (cannot infer a conflict)", () => {
    const v = evaluateMismatch({ scannedCode: "2881-6861", target: { name: "Some Product" } });
    expect(v.risk).toBe("safe");
  });

  it("does not flag a cross-domain link when only one side's domain is known", () => {
    const v = evaluateMismatch({
      scannedCode: "2881-6861",
      suggested: { name: "Falken Sincera ST80", brand: "Falken", category: "Tire" },
      target: { name: "Unlabeled item" }, // unknown domain
    });
    expect(v.risk).toBe("safe"); // unknown target domain -> no severe verdict (brand also differs but target brand empty)
  });
});
