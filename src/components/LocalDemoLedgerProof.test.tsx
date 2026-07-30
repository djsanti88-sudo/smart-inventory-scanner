import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import type { InventoryCount, ScanEvent } from "@/types";
import { LocalDemoLedgerProof } from "./LocalDemoLedgerProof";

const SESSION = "local-demo-proof-session";

function rows() {
  return Array.from({ length: 100 }, (_, index) => ({
    barcode: `0000000${String(index).padStart(6, "0")}`,
    barcodeType: "upc_a", canonicalProductUid: `canonical-${index + 1}`, brand: "Brand", model: "Model",
    size: "205/55R16", loadIndex: "91", speedRating: "V", manufacturerPartNumber: "", type: "passenger",
    season: "all_season", sourceCount: 1, confidence: "verified", currentStatus: "verified", usableFor: "decode",
    fieldCompletenessScore: 1, angle: "catalog", stratum: "A", ordinal: index + 1, batch: 1, agent: 1,
  }));
}

function payload() {
  const lockedRows = rows();
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    schemaVersion: 1, gitSha: "a".repeat(40), databaseSha256: "b".repeat(64), manifestSha256: "c".repeat(64),
    seed: "scanbin-local-tire-demo-v1", batch: 1, agent: 1, rowCount: 100,
    batchSha256: digest(lockedRows),
    expectedBarcodesSha256: digest(lockedRows.map((row) => row.barcode)),
    expectedCanonicalProductUidsSha256: digest(lockedRows.map((row) => row.canonicalProductUid)),
    rows: lockedRows,
  };
}

function event(index: number): ScanEvent {
  const row = rows()[index];
  return { id: `event-${index}`, businessId: "local-demo", sessionId: SESSION, rawCode: row.barcode, cleanCode: row.barcode,
    normalizedCandidates: [], matchedProductId: `product-${index}`, matchType: "upc", status: "known", resolverStatus: "known",
    codeType: "upc_a", reason: "local", quantityDelta: 1, quantityAfterScan: 1, createdAt: "2026-07-30T00:00:00.000Z",
    source: "scan", notes: "", syncStatus: "synced", syncError: null, idempotencyKey: `key-${index}`,
    localDemoCanonicalProductUid: row.canonicalProductUid };
}

function count(index: number): InventoryCount {
  return { id: `count-${index}`, businessId: "local-demo", sessionId: SESSION, productId: `product-${index}`, quantity: 1,
    lastScannedAt: "2026-07-30T00:00:00.000Z", aliasesSeen: [], scanEventIds: [`event-${index}`],
    createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z", syncStatus: "synced", syncError: null,
    appliedIdempotencyKeys: [] };
}

beforeEach(() => {
  useScanStore.setState({ sessionId: "", scanFeed: [], finalCounts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("LocalDemoLedgerProof", () => {
  it("fetches exactly the locked batch and renders a passing proof after browser hash verification", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const response = payload();
    const digestSpy = vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle));
    vi.stubGlobal("crypto", { subtle: { digest: digestSpy } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useScanStore.setState({ sessionId: SESSION, scanFeed: Array.from({ length: 100 }, (_, index) => event(index)), finalCounts: Array.from({ length: 100 }, (_, index) => count(index)) });

    render(<LocalDemoLedgerProof proofBatch="01" />);

    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent('"passed": true'));
    expect(fetchMock).toHaveBeenCalledWith("/api/local-demo/manifest/01", { cache: "no-store" });
    expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent(`"manifestSha256": "${response.manifestSha256}"`);

    useScanStore.setState((state) => ({ scanFeed: state.scanFeed.slice(1) }));
    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent('"passed": false'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(digestSpy).toHaveBeenCalledTimes(3);
  });

  it("fails closed without fetching for a non-canonical batch", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<LocalDemoLedgerProof proofBatch="1" />);

    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent('"passed": false'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when a client-recomputed payload hash disagrees", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const response = { ...payload(), batchSha256: "0".repeat(64) };
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));

    render(<LocalDemoLedgerProof proofBatch="01" />);

    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent('"passed": false'));
  });

  it.each([
    ["an extra key", (value: Record<string, unknown>) => { value.unexpected = true; }],
    ["a missing key", (value: Record<string, unknown>) => { delete value.manifestSha256; }],
  ])("fails closed for %s in the manifest payload", async (_label, mutate) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    vi.stubGlobal("crypto", webcrypto);
    const response = payload() as Record<string, unknown>;
    mutate(response);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));
    useScanStore.setState({ sessionId: SESSION });

    render(<LocalDemoLedgerProof proofBatch="01" />);

    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent('"passed": false'));
  });

  it("fails closed when browser SHA-256 is unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 })));
    useScanStore.setState({ sessionId: SESSION });

    render(<LocalDemoLedgerProof proofBatch="01" />);

    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent("Browser SHA-256 is unavailable"));
  });

  it.each([
    ["a non-OK response", () => new Response("unavailable", { status: 503 })],
    ["invalid JSON", () => new Response("{", { status: 200 })],
  ])("fails closed for %s", async (_label, makeResponse) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
    useScanStore.setState({ sessionId: SESSION });

    render(<LocalDemoLedgerProof proofBatch="01" />);

    await waitFor(() => expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent('"passed": false'));
  });

  it("fails closed without fetching when the active session is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<LocalDemoLedgerProof proofBatch="01" />);

    expect(screen.getByTestId("local-demo-ledger-proof")).toHaveTextContent("Missing active session");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
