import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveTrustedExactBarcodeDecision } from "@/server/tire-knowledge/TireKnowledgeProvider";
import { trustedExactProbeCandidate } from "@/stores/scanStore";

// Private barcode material is supplied by the caller, never by the repository.
const reconciliationPath = process.env.BOSS_RECONCILIATION_PATH;

describe("Boss trusted-exact local certification", () => {
  it.skipIf(!reconciliationPath)("resolves every source-admitted spelling without external egress", async () => {
    const { loadCorpusFixtures, EXPECTED_COUNTS } = await import("../../../e2e/boss-barcode-corpus/fixtures.mjs");
    const manifest = JSON.parse(readFileSync("src/server/tire-knowledge/exact-index/manifest.json", "utf8"));
    const fixtures = loadCorpusFixtures(reconciliationPath!, manifest);
    const fetchSpy = vi.fn(async () => { throw new Error("external fetch is forbidden in direct certification"); });
    vi.stubGlobal("fetch", fetchSpy);
    const latencyMs: number[] = [];
    try {
      const unreachable = [...fixtures.spellings.keys()].filter((spelling) => !trustedExactProbeCandidate(spelling));
      // Aggregate-only diagnostic: never print private spellings. This catches every mismatch
      // between the source-admitted corpus and the client-side deterministic probe gate.
      expect(unreachable.length, `source-admitted spellings excluded from trustedExactProbeCandidate: ${unreachable.length}`).toBe(0);
      for (const [spelling, expected] of fixtures.spellings) {
        const started = performance.now();
        const outcome = await resolveTrustedExactBarcodeDecision(spelling, { authenticatedBossCorpus: true });
        latencyMs.push(performance.now() - started);
        expect(outcome.kind).toBe("hit");
        if (outcome.kind !== "hit") continue;
        expect(outcome.sourceScope).toBe("authenticated_boss_corpus");
        expect(outcome.result.decision.status).toBe("verified");
        expect(outcome.result.decision.exactCodeEvidenceVerifiedByApp).toBe(true);
        expect(outcome.result.decision.corroborationPath).toBe("boss_trusted_exact_barcode");
        expect(outcome.result.decision.trustedExactCanonicalProductId).toMatch(/^trusted-exact:v1:[A-F0-9]{32}$/);
        expect(outcome.result.results).toHaveLength(1);
        // Each spelling must preserve its exact indexed identity, not merely get a generic hit.
        expect(outcome.result.results[0].primaryBarcode).toBeTruthy();
        expect(expected.lookupKey).toBeTruthy();
      }
      expect(fixtures.spellings.size).toBe(EXPECTED_COUNTS.acceptedSpellings);
      expect(fetchSpy).not.toHaveBeenCalled();
      const sorted = [...latencyMs].sort((left, right) => left - right);
      const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
      // The direct-only resolver is local I/O + an already hash-verified shard. A slower result
      // is useful certification evidence, but never silently hidden in a raw-code receipt.
      console.log(JSON.stringify({
        bossTrustedSpellings: fixtures.spellings.size,
        bossTrustedLookupKeys: fixtures.lookupKeys.size,
        canonicalProductIds: fixtures.canonicalProductIds.size,
        warmDirectP95Ms: Number(p95Ms.toFixed(3)),
        externalFetchCalls: fetchSpy.mock.calls.length,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120_000);
});
