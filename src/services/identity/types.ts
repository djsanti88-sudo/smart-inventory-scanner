export type IdentifierType =
  | "gtin"
  | "upc"
  | "ean"
  | "barcode"
  | "manufacturer_part_number"
  | "vendor_sku"
  | "oem_number"
  | "internal_code"
  | "shelf_code"
  | "source_alias";

export type EvidenceAuthority =
  | "approved_tenant_link"
  | "human_verified_master"
  | "verified_exact_code_corpus"
  | "vendor_import"
  | "unverified_master"
  | "provider_suggestion";

export type IdentityDecisionKind = "automatic" | "review" | "abstain" | "non_product" | "invalid";

export interface ScopedIdentifier {
  type: IdentifierType;
  raw: string;
  normalized: string;
  namespace?: string;
  source: string;
  evidenceAuthority: EvidenceAuthority;
  evidenceId: string;
  evidenceVersion: string;
}

export interface IdentityInput {
  businessId: string;
  sourceSystem: string;
  sourceSignature: string;
  vendorId: string;
  sourceFileFingerprint: string;
  sourceFileOrdinal: number;
  sheetName: string;
  sourceRowNumber: number;
  /** Adapter-declared structural row kind; arbitrary text never classifies a row as non-product. */
  recordType?: "product" | "labor" | "service" | "fee" | "subtotal" | "header";
  categoryHint?: string;
  identifiers: ScopedIdentifier[];
  brand?: string;
  title?: string;
  description?: string;
  attributes: Record<string, string>;
  quantity: number;
  unitOfMeasure?: string;
  rawRecordFingerprint: string;
}

export interface IdentityCandidate {
  productId: string;
  category: string;
  businessScope: "tenant" | "master";
  verificationTier: "approved" | "human_verified" | "exact_code_verified" | "suggested";
  automaticEligible: boolean;
  evidenceId: string;
  evidenceVersion: string;
  exactCodeEvidence: boolean;
  identifiers: ScopedIdentifier[];
  brand?: string;
  title?: string;
  attributes: Record<string, string>;
  catalogVersion: string;
  catalogSnapshotHash: string;
}

export interface IdentityDecision {
  kind: IdentityDecisionKind;
  targetProductId?: string;
  candidates: Array<{
    productId: string;
    rank: number;
    score?: number;
    evidence: string[];
    missingFields: string[];
    contradictions: string[];
  }>;
  selectedCandidateId?: string;
  decisionBasis: Array<{ rule: string; evidenceId: string; evidenceVersion: string }>;
  normalizedKeys: Array<{ type: IdentifierType; namespace?: string; value: string }>;
  constraintOutcomes: Array<{
    candidateId: string;
    result:
      | { outcome: "pass"; corroborated: string[]; missing: string[] }
      | { outcome: "reject"; contradictions: string[]; missing: string[] };
  }>;
  candidateSnapshotHash: string;
  engineVersion: string;
  pluginVersion: string;
  sourceRecordFingerprint: string;
  decisionFingerprint: string;
}

export interface IdentityCandidateSource {
  readonlyOnly: true;
  lookupBatch(inputs: IdentityInput[]): Promise<{
    catalogVersion: string;
    catalogSnapshotHash: string;
    candidatesByRecord: Map<string, IdentityCandidate[]>;
  }>;
}

export interface AggregateImportEvent {
  kind: "aggregate_import";
  eventId: string;
  idempotencyKey: string;
  fingerprint: string;
  importId: string;
  rowId: string;
  businessId: string;
  productId: string;
  sessionId: string;
  quantity: number;
  unitOfMeasure: "each";
  sourceFileOrdinal: number;
  sheetName: string;
  sourceRowNumber: number;
  createdAt: string;
}

export interface IdentityLink {
  businessId: string;
  sourceSystem: string;
  vendorId: string;
  sourceSignature: string;
  identifierType: IdentifierType;
  namespace: string;
  rawValue: string;
  normalizedValue: string;
  targetProductId: string;
  status: "proposed" | "approved" | "rejected" | "revoked";
  evidence: string[];
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  version: number;
}

export interface IdentityTransformation {
  businessId: string;
  sourceSystem: string;
  vendorId: string;
  sourceSignature: string;
  ruleKind: string;
  examples: string[];
  status: "proposed" | "approved" | "rejected" | "revoked";
  approvedBy?: string;
  approvedAt?: string;
  collisionTestIds: string[];
  version: number;
  revokedAt?: string;
  revokedBy?: string;
}

export interface CreateImportIdsInput {
  sanitizedContentRootHash: string;
  orderedMappings: Array<{ sheetName: string; mapping: Record<string, string> }>;
  businessId: string;
  sourceSystem: string;
  vendorId: string;
  importerVersion: string;
  originalFileHashes?: string[];
  issuedAt?: string;
  expiresAt?: string;
}

export interface ImportIds {
  importId: string;
}

export type ImportRunState = "previewed" | "applying" | "completed" | "failed" | "invalidated";

export interface ImportRun {
  importId: string;
  businessId: string;
  sourceFingerprint: string;
  mappingFingerprint: string;
  previewFingerprint: string;
  actorId: string;
  engineVersion: string;
  pluginVersion: string;
  catalogVersion: string;
  /** Binds mode and audited corrections for idempotent apply retries. */
  operationFingerprint?: string;
  createdAt: string;
  state: ImportRunState;
  /** Server-produced terminal result; never supplied by preview transport. */
  result?: unknown;
}

/** Durable, non-counting expected-inventory view for a reconcile import. */
export interface ExpectedInventorySession {
  importId: string;
  businessId: string;
  sourceEvidenceSnapshot: string;
  rows: Array<{ rowId: string; targetProductId?: string; expectedQuantity: number; currentQuantity: null; varianceQuantity: null; status: "unavailable"; correctionTargetProductId?: string }>;
}

export type ImportOperationState = "pending" | "applied" | "failed_retryable" | "failed_terminal";

export interface ImportOperation {
  businessId: string;
  importId: string;
  rowId: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  state: ImportOperationState;
  leaseId?: string;
  leaseExpiresAt?: number;
  result?: unknown;
}

export interface IdentityReview {
  reviewId: string;
  businessId: string;
  importId: string;
  rowId: string;
  decision: IdentityDecision;
  resolution?: "confirmed" | "rejected" | "create_product";
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface AggregateLedgerPort {
  applyOnce(event: AggregateImportEvent, idempotencyKey: string): Promise<AggregateLedgerResult>;
  findByIdempotencyKey(input: {
    businessId: string;
    idempotencyKey: string;
    expectedFingerprint: string;
  }): Promise<AggregateLedgerResult | null>;
  /** Compatibility adapter for pre-Task 9 callers. */
  apply(event: AggregateImportEvent, idempotencyKey: string, operationFingerprint: string): Promise<AggregateLedgerResult>;
  /** Compatibility adapter for pre-Task 9 callers. */
  get(input: { businessId: string; idempotencyKey: string; eventFingerprint: string; operationFingerprint: string }): Promise<{ event: AggregateImportEvent; idempotencyKey: string } | undefined>;
}

export type AggregateLedgerResult =
  | { event: AggregateImportEvent; idempotencyKey: string }
  | { kind: "idempotency_conflict"; idempotencyKey: string };
