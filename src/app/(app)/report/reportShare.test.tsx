import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  isLiveAuth: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/stores/scanStore", () => ({
  useScanStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mocks.storeState),
}));

vi.mock("@/services/auth/authMode", () => ({
  isLiveAuth: () => mocks.isLiveAuth(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: () => mocks.getSession(),
}));

import BossReportPage from "./page";

function seededStoreState() {
  return {
    businessId: "business-123",
    userId: "owner-123",
    currentSession: { id: "session-123", name: "July cycle count" },
    products: [
      {
        id: "product-1",
        brand: "Acme",
        category: "Parts",
      },
    ],
    finalCounts: [
      {
        productId: "product-1",
        quantity: 4,
      },
    ],
    scanFeed: [],
    countSnapshots: [
      {
        id: "snapshot-previous",
        label: "Previous count",
        takenAt: "2026-07-19T12:00:00.000Z",
        lines: [{ productId: "product-1", name: "Acme Part", qty: 1 }],
      },
      {
        id: "snapshot-current",
        label: "Current count",
        takenAt: "2026-07-20T12:00:00.000Z",
        lines: [{ productId: "product-1", name: "Acme Part", qty: 4 }],
      },
    ],
  };
}

function mockSuccessfulShare() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ url: "https://example.test/report/share-token" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mocks.storeState = seededStoreState();
  mocks.isLiveAuth.mockReset().mockReturnValue(false);
  mocks.getSession.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Boss Report sharing", () => {
  it("posts the current non-empty report snapshot and business id", async () => {
    const fetchMock = mockSuccessfulShare();
    render(<BossReportPage />);

    fireEvent.click(screen.getByTestId("share-report"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init?.body));

    expect(url).toBe("/api/share");
    expect(payload).toMatchObject({
      businessId: "business-123",
      sessionId: "session-123",
    });
    expect(payload.reportSnapshot.totalItems).toBeGreaterThan(0);
    expect(await screen.findByTestId("share-url")).toHaveTextContent(
      "https://example.test/report/share-token",
    );
  });

  it("includes the Firebase id token in live auth mode", async () => {
    const fetchMock = mockSuccessfulShare();
    const getIdToken = vi.fn().mockResolvedValue("firebase-id-token");
    mocks.isLiveAuth.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({ getIdToken });
    render(<BossReportPage />);

    fireEvent.click(screen.getByTestId("share-report"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(payload.idToken).toBe("firebase-id-token");
  });

  it("renders variances from the two most recent count snapshots", () => {
    render(<BossReportPage />);

    expect(screen.getByText("Top variances")).toBeInTheDocument();
    expect(screen.getByText(/Acme Part: \+3/)).toBeInTheDocument();
  });
});
