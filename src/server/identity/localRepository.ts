import { randomUUID } from "node:crypto";
import type {
  IdentityLink,
  IdentityReview,
  IdentityTransformation,
  ImportOperation,
  ImportRun,
  ImportRunState,
} from "@/services/identity/types";
import type { AtomicLocalStorage } from "./atomicLocalStorage";

const linksKey = "identity-links";
const transformationsKey = "identity-transformations";
const runsKey = "identity-runs";
const operationsKey = "identity-operations";
const reviewsKey = "identity-reviews";

type LinkLookup = Pick<
  IdentityLink,
  "businessId" | "sourceSystem" | "vendorId" | "sourceSignature" | "identifierType" | "namespace" | "normalizedValue"
>;

type OperationInput = Pick<ImportOperation, "businessId" | "importId" | "rowId" | "idempotencyKey">;

export type ImportOperationClaim =
  | { kind: "claimed"; operation: ImportOperation; leaseId: string }
  | { kind: "in_progress"; operation: ImportOperation }
  | { kind: "completed"; operation: ImportOperation; result: unknown };

export interface LocalIdentityRepository {
  saveIdentityLink(link: IdentityLink): Promise<IdentityLink>;
  saveTransformation(transformation: IdentityTransformation): Promise<IdentityTransformation>;
  resolveLink(input: LinkLookup): Promise<
    | { kind: "automatic"; link: IdentityLink }
    | { kind: "review"; transformation: IdentityTransformation }
    | { kind: "abstain" }
  >;
  createImportRun(run: Omit<ImportRun, "state">): Promise<ImportRun>;
  transitionImportRun(importId: string, next: ImportRunState): Promise<ImportRun>;
  claimImportOperation(input: OperationInput, now: number, leaseMilliseconds: number): Promise<ImportOperationClaim>;
  completeImportOperation(operation: ImportOperation, leaseId: string, result: unknown): Promise<ImportOperation>;
  saveIdentityReview(review: IdentityReview): Promise<IdentityReview>;
}

function sameScope(left: LinkLookup, right: LinkLookup): boolean {
  return (
    left.businessId === right.businessId &&
    left.sourceSystem === right.sourceSystem &&
    left.vendorId === right.vendorId &&
    left.sourceSignature === right.sourceSignature &&
    left.identifierType === right.identifierType &&
    left.namespace === right.namespace &&
    left.normalizedValue === right.normalizedValue
  );
}

function operationKey(input: Pick<ImportOperation, "businessId" | "importId" | "rowId">): string {
  return `${input.businessId}:${input.importId}:${input.rowId}`;
}

const allowedTransitions: Record<ImportRunState, ImportRunState[]> = {
  previewed: ["applying", "invalidated"],
  applying: ["completed", "failed", "invalidated"],
  completed: [],
  failed: ["applying", "invalidated"],
  invalidated: [],
};

export function createLocalRepository(storage: AtomicLocalStorage): LocalIdentityRepository {
  return {
    async saveIdentityLink(link) {
      return storage.transaction(async (transaction) => {
        const links = (await transaction.get<IdentityLink[]>(linksKey)) ?? [];
        const conflicting = links.find(
          (candidate) =>
            candidate.status === "approved" &&
            link.status === "approved" &&
            sameScope(candidate, link) &&
            candidate.targetProductId !== link.targetProductId,
        );
        if (conflicting) throw new Error(`Approved identity link already belongs to ${conflicting.targetProductId}`);
        const index = links.findIndex((candidate) => sameScope(candidate, link) && candidate.version === link.version);
        if (index >= 0) links[index] = link;
        else links.push(link);
        await transaction.set(linksKey, links);
        return link;
      });
    },
    async saveTransformation(transformation) {
      return storage.transaction(async (transaction) => {
        const transformations = (await transaction.get<IdentityTransformation[]>(transformationsKey)) ?? [];
        const index = transformations.findIndex(
          (candidate) =>
            candidate.businessId === transformation.businessId &&
            candidate.sourceSystem === transformation.sourceSystem &&
            candidate.vendorId === transformation.vendorId &&
            candidate.sourceSignature === transformation.sourceSignature &&
            candidate.ruleKind === transformation.ruleKind &&
            candidate.version === transformation.version,
        );
        if (index >= 0) transformations[index] = transformation;
        else transformations.push(transformation);
        await transaction.set(transformationsKey, transformations);
        return transformation;
      });
    },
    async resolveLink(input) {
      return storage.transaction(async (transaction) => {
        const links = (await transaction.get<IdentityLink[]>(linksKey)) ?? [];
        const exact = links.find((link) => link.status === "approved" && sameScope(link, input));
        if (exact) return { kind: "automatic" as const, link: exact };
        const transformations = (await transaction.get<IdentityTransformation[]>(transformationsKey)) ?? [];
        const vendorWide = transformations.find(
          (rule) =>
            rule.status === "approved" &&
            rule.sourceSignature === "*" &&
            rule.businessId === input.businessId &&
            rule.sourceSystem === input.sourceSystem &&
            rule.vendorId === input.vendorId,
        );
        return vendorWide ? { kind: "review" as const, transformation: vendorWide } : { kind: "abstain" as const };
      });
    },
    async createImportRun(run) {
      return storage.transaction(async (transaction) => {
        const runs = (await transaction.get<ImportRun[]>(runsKey)) ?? [];
        const existing = runs.find((candidate) => candidate.importId === run.importId && candidate.businessId === run.businessId);
        if (existing) return existing;
        const created: ImportRun = { ...run, state: "previewed" };
        runs.push(created);
        await transaction.set(runsKey, runs);
        return created;
      });
    },
    async transitionImportRun(importId, next) {
      return storage.transaction(async (transaction) => {
        const runs = (await transaction.get<ImportRun[]>(runsKey)) ?? [];
        const index = runs.findIndex((run) => run.importId === importId);
        if (index < 0) throw new Error(`Unknown import run ${importId}`);
        const current = runs[index];
        if (!allowedTransitions[current.state].includes(next)) {
          throw new Error(`Import run cannot transition from ${current.state} to ${next}`);
        }
        const updated = { ...current, state: next };
        runs[index] = updated;
        await transaction.set(runsKey, runs);
        return updated;
      });
    },
    async claimImportOperation(input, now, leaseMilliseconds) {
      return storage.transaction(async (transaction) => {
        const operations = (await transaction.get<Record<string, ImportOperation>>(operationsKey)) ?? {};
        const key = operationKey(input);
        const existing = operations[key];
        if (existing?.state === "applied") return { kind: "completed" as const, operation: existing, result: existing.result };
        if (existing?.leaseExpiresAt && existing.leaseExpiresAt > now) return { kind: "in_progress" as const, operation: existing };
        const leaseId = randomUUID();
        const operation: ImportOperation = {
          ...existing,
          ...input,
          state: "pending",
          leaseId,
          leaseExpiresAt: now + leaseMilliseconds,
        };
        operations[key] = operation;
        await transaction.set(operationsKey, operations);
        return { kind: "claimed" as const, operation, leaseId };
      });
    },
    async completeImportOperation(operation, leaseId, result) {
      return storage.transaction(async (transaction) => {
        const operations = (await transaction.get<Record<string, ImportOperation>>(operationsKey)) ?? {};
        const key = operationKey(operation);
        const current = operations[key];
        if (!current || current.state !== "pending" || current.leaseId !== leaseId) throw new Error("Import operation lease is not owned");
        const completed: ImportOperation = { ...current, state: "applied", leaseId: undefined, leaseExpiresAt: undefined, result };
        operations[key] = completed;
        await transaction.set(operationsKey, operations);
        return completed;
      });
    },
    async saveIdentityReview(review) {
      return storage.transaction(async (transaction) => {
        const reviews = (await transaction.get<IdentityReview[]>(reviewsKey)) ?? [];
        const index = reviews.findIndex((candidate) => candidate.reviewId === review.reviewId && candidate.businessId === review.businessId);
        if (index >= 0) reviews[index] = review;
        else reviews.push(review);
        await transaction.set(reviewsKey, reviews);
        return review;
      });
    },
  };
}
