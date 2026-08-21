import type { Settings } from "@/types";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";
import { DECODE_BUDGET_DEFAULT_MS } from "@/services/ai/decodeBudget";

export const DEFAULT_SETTINGS: Settings = {
  businessId: DEMO_BUSINESS_ID,
  ownerPinHash: "",
  aiLookupEnabled: true,
  dailyLookupLimit: 200,
  dailyLookupCount: 0,
  lastResetDate: "1970-01-01",
  requireHumanApprovalForMerges: true,
  allowImageSuggestions: true,
  allowProductUrlSuggestions: true,
  scannerSubmitMode: "both",
  scannerDebounceMs: 80,
  enablePendingSyncQueue: true,
  enableIdempotentSync: true,
  autoSuggestUnknowns: false,
  autoAddDecodedProducts: true,
  decodeBudgetMs: DECODE_BUDGET_DEFAULT_MS,
  autoCatalogLearningEnabled: true,
  autoVerifyConfidenceThreshold: 80,
  scanContext: "tire",
  trustedSourceAutoVerifyEnabled: true,
  aiOnlyAutoVerifyAllowed: false,
  autoCountNonPublicWithEvidence: true,
};
