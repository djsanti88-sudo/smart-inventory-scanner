"use client";

import type { FeedDecodeStatus, MatchType, ScanStatus, SyncStatus } from "@/types";

// PLAN C, TASK 1 (presentational only): collapse the weak decode states into a single
// "Suggested" label/style. needs_review and conflict are non-blocking LABELS (Plan A already
// makes every scan count), so the user only ever sees Verified or Suggested here - no wall.
// This does NOT change the underlying decodeStatus enum or any counting/gating logic.
export function DecodeStatusBadge({ status }: { status: FeedDecodeStatus }) {
  const map: Record<FeedDecodeStatus, [string, string]> = {
    none: ["", ""],
    decoding: ["bg-blue-100 text-blue-700 animate-pulse", "Looking up product..."],
    verified: ["bg-green-100 text-green-800", "Verified match"],
    suggested: ["bg-amber-100 text-amber-900", "Suggested"],
    conflict: ["bg-amber-100 text-amber-900", "Suggested"],
    needs_review: ["bg-amber-100 text-amber-900", "Suggested"],
    vendor_label: ["bg-purple-100 text-purple-700", "Vendor label"],
  };
  const [cls, label] = map[status];
  return (
    <span className={`rounded-md px-2 py-1 text-sm font-medium ${cls}`} data-testid="decode-row-status">
      {label}
    </span>
  );
}

// Small shared status badges. Plain front-end rendering, no business logic.

const MATCH_LABEL: Record<MatchType, string> = {
  exact_alias: "Exact alias",
  normalized_alias: "Alias",
  primary_barcode: "Barcode",
  primary_sku: "SKU",
  gtin: "GTIN",
  upc: "UPC",
  ean: "EAN",
  unknown: "Unknown",
  conflict: "Conflict",
};

export function MatchBadge({ type }: { type: MatchType }) {
  const color =
    type === "unknown"
      ? "bg-red-100 text-red-800"
      : type === "conflict"
        ? "bg-amber-100 text-amber-900"
        : "bg-blue-100 text-blue-700";
  return (
    <span className={`rounded-md px-2 py-1 text-sm font-medium ${color}`}>{MATCH_LABEL[type]}</span>
  );
}

export function SyncBadge({ status }: { status: SyncStatus }) {
  const map: Record<SyncStatus, string> = {
    synced: "bg-green-100 text-green-800 transition-colors duration-300",
    pending: "bg-amber-100 text-amber-900",
    error: "bg-red-100 text-red-800",
  };
  const label: Record<SyncStatus, string> = {
    synced: "Saved",
    pending: "Not saved yet",
    error: "Save error",
  };
  return (
    <span className={`rounded-md px-2 py-1 text-sm font-medium ${map[status]}`} data-testid="sync-badge">
      {label[status]}
    </span>
  );
}

export function StatusBadge({ status }: { status: ScanStatus }) {
  const map: Record<ScanStatus, string> = {
    known: "bg-green-100 text-green-700",
    unknown: "bg-red-100 text-red-800",
    needs_review: "bg-amber-100 text-amber-900",
    resolved: "bg-blue-100 text-blue-700",
    ignored: "bg-zinc-100 text-zinc-600",
    conflict: "bg-amber-100 text-amber-900",
  };
  const label: Record<ScanStatus, string> = {
    known: "Counted",
    unknown: "Not recognised",
    needs_review: "Needs review",
    resolved: "Resolved",
    ignored: "Ignored",
    conflict: "Conflict",
  };
  return <span className={`rounded-md px-2 py-1 text-sm font-medium ${map[status]}`}>{label[status]}</span>;
}
