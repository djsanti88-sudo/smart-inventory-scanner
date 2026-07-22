// Fetch V2 cache: verified results forever, rejected/bad URLs with TTL so known-junk pages are
// never re-fetched (the "do not repeatedly spend time on known bad pages" rule). In-memory per
// instance; a durable/shared layer is a Phase C+ decision. Clock injected for testability.
import type { FetchV2Result } from "./types";

const DEFAULT_BAD_URL_TTL_MS = 24 * 60 * 60 * 1000; // 24h: junk pages rarely become products overnight
const DEFAULT_MAX_ENTRIES = 5000;

export class FetchV2Cache {
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly badUrlTtlMs: number;
  private readonly verified = new Map<string, FetchV2Result>();
  private readonly badUrls = new Map<string, { reason: string; expiresAt: number }>();

  constructor(opts?: { now?: () => number; maxEntries?: number; badUrlTtlMs?: number }) {
    this.now = opts?.now ?? Date.now;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.badUrlTtlMs = opts?.badUrlTtlMs ?? DEFAULT_BAD_URL_TTL_MS;
  }

  getVerified(primary: string): FetchV2Result | undefined {
    return this.verified.get(primary);
  }

  saveVerified(primary: string, result: FetchV2Result): void {
    if (this.verified.size >= this.maxEntries) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
    this.verified.set(primary, result);
  }

  isBadUrl(url: string): boolean {
    const e = this.badUrls.get(url);
    if (!e) return false;
    if (e.expiresAt <= this.now()) {
      this.badUrls.delete(url);
      return false;
    }
    return true;
  }

  markBadUrl(url: string, reason: string): void {
    if (this.badUrls.size >= this.maxEntries) {
      const oldest = this.badUrls.keys().next().value;
      if (oldest !== undefined) this.badUrls.delete(oldest);
    }
    this.badUrls.set(url, { reason, expiresAt: this.now() + this.badUrlTtlMs });
  }

  badUrlReason(url: string): string {
    const e = this.badUrls.get(url);
    return e && e.expiresAt > this.now() ? e.reason : "";
  }

  // --- No-result receipts (owner rule 2026-07-04): PERMANENT, no auto-retry ever. A receipted
  // code spends zero searches until the owner explicitly clears it (ladder handles the residue).
  private readonly noResults = new Map<string, string>();

  getNoResult(primary: string): string | undefined {
    return this.noResults.get(primary);
  }

  markNoResult(primary: string, note: string): void {
    if (this.noResults.size >= this.maxEntries) {
      const oldest = this.noResults.keys().next().value;
      if (oldest !== undefined) this.noResults.delete(oldest);
    }
    this.noResults.set(primary, note);
  }
}
