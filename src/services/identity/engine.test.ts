import { describe, expect, it, vi } from "vitest";

import { decideIdentity, decideIdentityBatch, type IdentityCandidateSnapshot } from "./engine";
import { genericIdentityPlugin } from "./plugins";
import type { IdentityCandidate, IdentityCandidateSource, IdentityInput, ScopedIdentifier } from "./types";

const identifier = (overrides: Partial<ScopedIdentifier> = {}): ScopedIdentifier => ({
  type: "gtin",
  raw: "4006381333931",
  normalized: "4006381333931",
  source: "import",
  evidenceAuthority: "vendor_import",
  evidenceId: "input-code",
  evidenceVersion: "v1",
  ...overrides,
});

const input = (overrides: Partial<IdentityInput> = {}): IdentityInput => ({
  businessId: "business-1",
  sourceSystem: "vendor-export",
  sourceSignature: "schema-v1",
  vendorId: "vendor-a",
  sourceFileFingerprint: "file-1",
  sourceFileOrdinal: 0,
  sheetName: "Inventory",
  sourceRowNumber: 2,
  identifiers: [identifier()],
  attributes: {},
  quantity: 1,
  unitOfMeasure: "each",
  rawRecordFingerprint: "row-1",
  ...overrides,
});

const candidate = (overrides: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  productId: "product-1",
  category: "general",
  businessScope: "master",
  verificationTier: "human_verified",
  automaticEligible: true,
  evidenceId: "catalog-code-1",
  evidenceVersion: "v1",
  exactCodeEvidence: true,
  identifiers: [identifier({ source: "catalog", evidenceAuthority: "human_verified_master", evidenceId: "catalog-code-1" })],
  attributes: {},
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-1",
  ...overrides,
});

const snapshot = (candidates: IdentityCandidate[]): IdentityCandidateSnapshot => ({
  catalogVersion: "catalog-v1",
  catalogSnapshotHash: "snapshot-1",
  candidates,
});

describe("identity decision engine", () => {
  it("makes a unique approved exact candidate automatic", async () => {
    const decision = await decideIdentity(input(), snapshot([candidate()]), genericIdentityPlugin);

    expect(decision.kind).toBe("automatic");
    expect(decision.targetProductId).toBe("product-1");
    expect(decision.selectedCandidateId).toBe("product-1");
    expect(decision.decisionBasis).toContainEqual({
      rule: "unique_immutable_exact_evidence",
      evidenceId: "catalog-code-1",
      evidenceVersion: "v1",
    });
  });

  it.each([
    ["exact collision", [candidate(), candidate({ productId: "product-2", evidenceId: "catalog-code-2" })]],
    ["provider candidate", [candidate({ verificationTier: "suggested", automaticEligible: false })]],
    ["unverified candidate", [candidate({ verificationTier: "suggested", automaticEligible: true })]],
  ])("routes a %s to review", async (_name, candidates) => {
    await expect(decideIdentity(input(), snapshot(candidates), genericIdentityPlugin)).resolves.toMatchObject({ kind: "review" });
  });

  it("keeps semantic-only similarity review-only", async () => {
    const decision = await decideIdentity(
      input({ title: "Premium all season tire" }),
      snapshot([candidate({ identifiers: [], title: "Premium all season tire", exactCodeEvidence: false })]),
      genericIdentityPlugin,
    );

    expect(decision.kind).toBe("review");
    expect(decision.candidates[0]?.score).toBe(1);
  });

  it("rejects hard contradictions and abstains when none remain", async () => {
    const decision = await decideIdentity(
      input({ categoryHint: "hardware" }),
      snapshot([candidate({ category: "apparel" })]),
      genericIdentityPlugin,
    );

    expect(decision.kind).toBe("abstain");
    expect(decision.constraintOutcomes[0]).toMatchObject({ candidateId: "product-1", result: { outcome: "reject" } });
  });

  it("abstains when no candidate is available", async () => {
    await expect(decideIdentity(input(), snapshot([]), genericIdentityPlugin)).resolves.toMatchObject({ kind: "abstain" });
  });

  it.each(["labor", "service", "fee", "subtotal", "header"]) (
    "classifies exact allowlisted category %s as non-product",
    async (categoryHint) => {
      await expect(decideIdentity(input({ categoryHint }), snapshot([]), genericIdentityPlugin)).resolves.toMatchObject({
        kind: "non_product",
      });
    },
  );

  it("does not classify free text as non-product", async () => {
    await expect(
      decideIdentity(input({ title: "labor charge", categoryHint: undefined, identifiers: [] }), snapshot([]), genericIdentityPlugin),
    ).resolves.toMatchObject({ kind: "abstain" });
  });

  it("returns invalid for malformed input without inspecting candidates", async () => {
    const decision = await decideIdentity({ ...input(), quantity: -1 } as IdentityInput, snapshot([candidate()]), genericIdentityPlugin);

    expect(decision).toMatchObject({ kind: "invalid", candidates: [] });
  });

  it("orders candidates and fingerprints independently of source candidate order", async () => {
    const first = candidate({ productId: "product-b", exactCodeEvidence: false, automaticEligible: false, title: "near match" });
    const second = candidate({ productId: "product-a", exactCodeEvidence: false, automaticEligible: false, title: "near match" });

    const forward = await decideIdentity(input({ title: "near match" }), snapshot([first, second]), genericIdentityPlugin);
    const reverse = await decideIdentity(input({ title: "near match" }), snapshot([second, first]), genericIdentityPlugin);

    expect(reverse.candidates).toEqual(forward.candidates);
    expect(reverse.decisionFingerprint).toBe(forward.decisionFingerprint);
  });

  it("deduplicates repeated product evidence without collapsing a real product collision", async () => {
    const repeated = candidate({ evidenceId: "catalog-code-duplicate" });
    const collision = candidate({ productId: "product-2", evidenceId: "catalog-code-2" });
    const decision = await decideIdentity(input(), snapshot([candidate(), repeated, collision]), genericIdentityPlugin);

    expect(decision.kind).toBe("review");
    expect(decision.candidates.map((entry) => entry.productId)).toEqual(["product-1", "product-2"]);
  });

  it("uses a read-only source once for a batch and preserves input order", async () => {
    const first = input({ rawRecordFingerprint: "row-1" });
    const second = input({ rawRecordFingerprint: "row-2" });
    const lookupBatch = vi.fn<IdentityCandidateSource["lookupBatch"]>().mockResolvedValue({
      catalogVersion: "catalog-v1",
      catalogSnapshotHash: "snapshot-1",
      candidatesByRecord: new Map([["row-1", [candidate()]], ["row-2", []]]),
    });
    const source: IdentityCandidateSource = { readonlyOnly: true, lookupBatch };

    const decisions = await decideIdentityBatch([first, second], source);

    expect(lookupBatch).toHaveBeenCalledTimes(1);
    expect(lookupBatch).toHaveBeenCalledWith([first, second]);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((decision) => decision.kind)).toEqual(["automatic", "abstain"]);
    expect(decisions.map((decision) => decision.sourceRecordFingerprint)).toEqual(["row-1", "row-2"]);
  });
});
