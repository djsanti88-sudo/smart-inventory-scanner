import type { Alias, PendingSyncItem, ScanEvent, UnknownCodeReview } from "@/types";

// A local mock of the backend. Its ONLY job for proof purposes is to be IDEMPOTENT:
// applying the same sync operation (same idempotencyKey / scanEvent id) more than once must not
// change inventory a second time. This is what guarantees retry sync never double-counts.
//
// Framework-free. Optional localStorage persistence is guarded so it is a no-op under Node tests.

export interface ServerCount {
  businessId: string;
  sessionId: string;
  productId: string;
  quantity: number;
  scanEventIds: string[];
  appliedIdempotencyKeys: string[];
}

export interface MockDbState {
  scanEvents: Record<string, ScanEvent>;
  counts: Record<string, ServerCount>; // key = `${sessionId}|${productId}`
  aliases: Record<string, Alias>; // key = `${businessId}|${cleanCode}|${productId}`
  reviews: Record<string, UnknownCodeReview>;
  appliedKeys: string[];
}

export interface SyncResult {
  ok: boolean;
  alreadyApplied: boolean;
  error?: string;
}

/** Failure simulation is for MOCK/TEST proof only - never used by production logic. */
export type FailureMode = "none" | "always" | { failTimes: number };

function emptyState(): MockDbState {
  return { scanEvents: {}, counts: {}, aliases: {}, reviews: {}, appliedKeys: [] };
}

const countKey = (sessionId: string, productId: string) => `${sessionId}|${productId}`;
const aliasKey = (businessId: string, cleanCode: string, productId: string) =>
  `${businessId}|${cleanCode}|${productId}`;

export class MockDb {
  private state: MockDbState;
  private failure: FailureMode = "none";
  private failuresLeft = 0;
  private readonly storageKey: string | null;

  constructor(options?: { storageKey?: string; persist?: boolean }) {
    this.storageKey = options?.persist ? (options.storageKey ?? "sis-mockdb-v1") : null;
    this.state = this.load() ?? emptyState();
  }

  // --- failure simulation (mock/test only) ---
  setFailure(mode: FailureMode) {
    this.failure = mode;
    this.failuresLeft = typeof mode === "object" ? mode.failTimes : 0;
  }

  private shouldFail(): boolean {
    if (this.failure === "always") return true;
    if (typeof this.failure === "object" && this.failuresLeft > 0) {
      this.failuresLeft--;
      return true;
    }
    return false;
  }

  // --- idempotent apply of one queued operation ---
  apply(item: PendingSyncItem): SyncResult {
    if (this.shouldFail()) {
      return { ok: false, alreadyApplied: false, error: "Simulated sync failure" };
    }

    // Global key dedupe: if we have already applied this exact operation, it is a safe no-op.
    if (item.idempotencyKey && this.state.appliedKeys.includes(item.idempotencyKey)) {
      return { ok: true, alreadyApplied: true };
    }

    switch (item.operation) {
      case "SAVE_SCAN_EVENT":
        this.upsertScanEvent(item.payload as ScanEvent);
        break;
      case "INCREMENT_COUNT":
        this.applyIncrement(item.payload as IncrementPayload);
        break;
      case "SAVE_UNKNOWN_SCAN":
        this.upsertReview(item.payload as UnknownCodeReview);
        break;
      case "RESOLVE_ALIAS":
        this.upsertAlias(item.payload as Alias);
        break;
      default:
        return { ok: false, alreadyApplied: false, error: `Unknown operation ${item.operation}` };
    }

    if (item.idempotencyKey) this.state.appliedKeys.push(item.idempotencyKey);
    this.save();
    return { ok: true, alreadyApplied: false };
  }

  // --- idempotent primitives ---
  upsertScanEvent(event: ScanEvent) {
    // Upsert by id: re-saving the same event id never creates a duplicate.
    this.state.scanEvents[event.id] = { ...event, syncStatus: "synced", syncError: null };
  }

  applyIncrement(p: IncrementPayload) {
    const key = countKey(p.sessionId, p.productId);
    const existing =
      this.state.counts[key] ??
      ({
        businessId: p.businessId,
        sessionId: p.sessionId,
        productId: p.productId,
        quantity: 0,
        scanEventIds: [],
        appliedIdempotencyKeys: [],
      } satisfies ServerCount);

    // Dedupe by scanEvent id AND by idempotency key: either being present means no re-apply.
    const seenEvent = p.scanEventId && existing.scanEventIds.includes(p.scanEventId);
    const seenKey = p.idempotencyKey && existing.appliedIdempotencyKeys.includes(p.idempotencyKey);
    if (seenEvent || seenKey) {
      this.state.counts[key] = existing;
      return;
    }

    this.state.counts[key] = {
      ...existing,
      quantity: existing.quantity + (p.quantityDelta ?? 1),
      scanEventIds: p.scanEventId ? [...existing.scanEventIds, p.scanEventId] : existing.scanEventIds,
      appliedIdempotencyKeys: p.idempotencyKey
        ? [...existing.appliedIdempotencyKeys, p.idempotencyKey]
        : existing.appliedIdempotencyKeys,
    };
  }

  upsertAlias(alias: Alias) {
    // Dedupe by (businessId, cleanCode, productId): the same mapping is never duplicated.
    this.state.aliases[aliasKey(alias.businessId, alias.cleanCode, alias.productId)] = {
      ...alias,
      syncStatus: "synced",
    };
  }

  upsertReview(review: UnknownCodeReview) {
    this.state.reviews[review.id] = { ...review, syncStatus: "synced" };
  }

  // --- read helpers ---
  getServerCount(sessionId: string, productId: string): ServerCount | undefined {
    return this.state.counts[countKey(sessionId, productId)];
  }
  getScanEvent(id: string): ScanEvent | undefined {
    return this.state.scanEvents[id];
  }
  getAlias(businessId: string, cleanCode: string, productId: string): Alias | undefined {
    return this.state.aliases[aliasKey(businessId, cleanCode, productId)];
  }
  snapshot(): MockDbState {
    return JSON.parse(JSON.stringify(this.state));
  }
  reset() {
    this.state = emptyState();
    this.save();
  }

  // --- persistence (no-op under Node) ---
  private load(): MockDbState | null {
    if (!this.storageKey || typeof window === "undefined" || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      return raw ? (JSON.parse(raw) as MockDbState) : null;
    } catch {
      return null;
    }
  }
  private save() {
    if (!this.storageKey || typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // ignore quota / serialization errors in mock mode
    }
  }
}

export interface IncrementPayload {
  businessId: string;
  sessionId: string;
  productId: string;
  scanEventId: string;
  quantityDelta: number;
  idempotencyKey: string;
}

/** A shared singleton for the app (browser-persisted). Tests construct their own instances. */
let singleton: MockDb | null = null;
export function getMockDb(): MockDb {
  if (!singleton) singleton = new MockDb({ persist: true });
  return singleton;
}
