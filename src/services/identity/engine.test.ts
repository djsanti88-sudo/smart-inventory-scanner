import { describe, expect, it, vi } from "vitest";

import {
  decideIdentity,
  decideIdentityBatch,
  identityDecisionFingerprintProjection,
  type IdentityCandidateSnapshot,
} from "./engine";
import { canonicalSha256 } from "./canonical";
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

  it("classifies an explicit adapter record type as non-product but never arbitrary text", async () => {
    await expect(decideIdentity(input({ recordType: "labor" }), snapshot([]), genericIdentityPlugin)).resolves.toMatchObject({
      kind: "non_product",
      decisionBasis: [expect.objectContaining({ rule: "explicit_adapter_record_type" })],
    });
    await expect(
      decideIdentity(input({ recordType: "labor charge" as "labor" }), snapshot([]), genericIdentityPlugin),
    ).resolves.toMatchObject({ kind: "abstain" });
  });

  it("returns invalid malformed runtime input without normalizing it", async () => {
    const normalize = vi.fn(() => {
      throw new Error("invalid input must not normalize");
    });
    const plugin = { ...genericIdentityPlugin, normalize };
    const malformed = { rawRecordFingerprint: "bad-row", identifiers: "not-an-array" } as unknown as IdentityInput;
    const decision = await decideIdentity(malformed, snapshot([candidate()]), plugin);

    expect(normalize).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ kind: "invalid", candidates: [], normalizedKeys: [], sourceRecordFingerprint: "bad-row" });
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

  it("uses the qualifying immutable evidence deterministically for duplicate product records", async () => {
    const provider = candidate({ verificationTier: "suggested", automaticEligible: false, evidenceId: "provider-evidence" });
    const verified = candidate({ evidenceId: "verified-evidence", evidenceVersion: "v2" });
    const providerFirst = await decideIdentity(input(), snapshot([provider, verified]), genericIdentityPlugin);
    const verifiedFirst = await decideIdentity(input(), snapshot([verified, provider]), genericIdentityPlugin);

    expect(providerFirst).toEqual(verifiedFirst);
    expect(providerFirst.decisionBasis).toEqual([
      { rule: "unique_immutable_exact_evidence", evidenceId: "verified-evidence", evidenceVersion: "v2" },
    ]);
  });

  it("uses the common fingerprint projection for contradicted abstentions", async () => {
    const decision = await decideIdentity(
      input({ categoryHint: "hardware" }),
      snapshot([candidate({ category: "apparel" })]),
      genericIdentityPlugin,
    );

    expect(decision.kind).toBe("abstain");
    await expect(canonicalSha256(identityDecisionFingerprintProjection(decision))).resolves.toBe(decision.decisionFingerprint);
    await expect(
      decideIdentity(input({ categoryHint: "hardware" }), snapshot([candidate({ category: "apparel" })]), genericIdentityPlugin),
    ).resolves.toMatchObject({ decisionFingerprint: decision.decisionFingerprint });
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

  it("accounts for malformed batch rows without sending them to the candidate source", async () => {
    const valid = input({ rawRecordFingerprint: "valid-row" });
    const malformed = { rawRecordFingerprint: "invalid-row", identifiers: "not-an-array" } as unknown as IdentityInput;
    const lookupBatch = vi.fn<IdentityCandidateSource["lookupBatch"]>().mockResolvedValue({
      catalogVersion: "catalog-v1",
      catalogSnapshotHash: "snapshot-1",
      candidatesByRecord: new Map([["valid-row", [candidate()]]]),
    });

    const decisions = await decideIdentityBatch([valid, malformed], { readonlyOnly: true, lookupBatch });

    expect(lookupBatch).toHaveBeenCalledOnce();
    expect(lookupBatch).toHaveBeenCalledWith([valid]);
    expect(decisions.map((decision) => decision.kind)).toEqual(["automatic", "invalid"]);
    expect(decisions.map((decision) => decision.sourceRecordFingerprint)).toEqual(["valid-row", "invalid-row"]);
  });
});
