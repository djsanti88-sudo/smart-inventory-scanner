"use client";

import type { FeedDecodeStatus, MatchType, ScanStatus, SyncStatus } from "@/types";

export function DecodeStatusBadge({ status }: { status: FeedDecodeStatus }) {
  const map: Record<FeedDecodeStatus, [string, string]> = {
    none: ["", ""],
    decoding: ["bg-blue-100 text-blue-700", "Decoding with AI..."],
    verified: ["bg-green-100 text-green-800", "Verified AI Decode"],
    suggested: ["bg-amber-100 text-amber-800", "Suggested"],
    conflict: ["bg-red-100 text-red-700", "Conflict"],
    needs_review: ["bg-zinc-100 text-zinc-600", "Needs review"],
    vendor_label: ["bg-purple-100 text-purple-700", "Vendor label"],
  };
  const [cls, label] = map[status];
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`} data-testid="decode-row-status">
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
      ? "bg-red-100 text-red-700"
      : type === "conflict"
        ? "bg-amber-100 text-amber-800"
        : "bg-blue-100 text-blue-700";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${color}`}>{MATCH_LABEL[type]}</span>
  );
}

export function SyncBadge({ status }: { status: SyncStatus }) {
  const map: Record<SyncStatus, string> = {
    synced: "bg-green-100 text-green-700",
    pending: "bg-amber-100 text-amber-800",
    error: "bg-red-100 text-red-700",
  };
  const label: Record<SyncStatus, string> = {
    synced: "Synced",
    pending: "Pending",
    error: "Sync error",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${map[status]}`} data-testid="sync-badge">
      {label[status]}
    </span>
  );
}

export function StatusBadge({ status }: { status: ScanStatus }) {
  const map: Record<ScanStatus, string> = {
    known: "bg-green-100 text-green-700",
    unknown: "bg-red-100 text-red-700",
    needs_review: "bg-amber-100 text-amber-800",
    resolved: "bg-blue-100 text-blue-700",
    ignored: "bg-zinc-100 text-zinc-600",
    conflict: "bg-amber-100 text-amber-800",
  };
  const label: Record<ScanStatus, string> = {
    known: "Known",
    unknown: "Unknown",
    needs_review: "Needs review",
    resolved: "Resolved",
    ignored: "Ignored",
    conflict: "Conflict",
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${map[status]}`}>{label[status]}</span>;
}
