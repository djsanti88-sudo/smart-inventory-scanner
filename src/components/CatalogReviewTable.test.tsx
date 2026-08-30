import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// Task 3: component tests for the platform-owner-only catalog review table. Mocks
// useIsPlatformOwner (mirrors src/components/settingsAccount.test.tsx), @/authentication/auth's getSession
// (for the ID token), and global fetch.

let isPlatform = true;
vi.mock("@/services/security/useAccessLevel", () => ({
  useIsPlatformOwner: () => isPlatform,
}));

const fakeUser = { getIdToken: vi.fn().mockResolvedValue("fake-id-token") };
const getSession = vi.fn();
vi.mock("@/authentication/auth", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

import { CatalogReviewTable } from "@/components/CatalogReviewTable";

function pendingEntry(over: Record<string, unknown> = {}) {
  return {
    id: "gtin_1",
    normalizedBarcode: "0123456789012",
    name: "Widget",
    brand: "Acme",
    size: "10 pack",
    confidence: 0.9,
    evidenceSummary: "Two agreeing sources",
    firstSeenAt: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  isPlatform = true;
  getSession.mockReset().mockResolvedValue(fakeUser);
  fakeUser.getIdToken.mockReset().mockResolvedValue("fake-id-token");
  global.fetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CatalogReviewTable access gating", () => {
  it("shows an access-restricted message and does not fetch for a non-platform-owner", async () => {
    isPlatform = false;
    render(<CatalogReviewTable />);
    expect(screen.getByTestId("catalog-review-forbidden")).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("CatalogReviewTable rows + empty state", () => {
  it("renders an honest empty state when there are no pending entries", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [], nextCursor: null }),
    });
    render(<CatalogReviewTable />);
    await waitFor(() => expect(screen.getByTestId("catalog-review-empty")).toBeTruthy());
  });

  it("renders a row per pending entry with barcode, name, brand, confidence, evidence, and date", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [pendingEntry()], nextCursor: null }),
    });
    render(<CatalogReviewTable />);
    await waitFor(() => expect(screen.getByTestId("catalog-review-row-gtin_1")).toBeTruthy());
    const row = screen.getByTestId("catalog-review-row-gtin_1");
    expect(row.textContent).toContain("0123456789012");
    expect(row.textContent).toContain("Widget");
    expect(row.textContent).toContain("Acme");
    // Owner decision 2026-08-19: an app-derived band word, never a raw provider percentage.
    expect(row.textContent).toContain("Medium");
    expect(row.textContent).not.toContain("%");
    expect(row.textContent).toContain("Two agreeing sources");
  });

  it("shows a load error when the list request fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Platform owner access required." }),
    });
    render(<CatalogReviewTable />);
    await waitFor(() => expect(screen.getByTestId("catalog-review-error")).toBeTruthy());
    expect(screen.getByTestId("catalog-review-error").textContent).toMatch(/platform owner/i);
  });
});

describe("CatalogReviewTable approve/reject actions", () => {
  it("calls the approve API and removes the row from the pending list on success", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/catalog-review?")) {
        return { ok: true, json: async () => ({ entries: [pendingEntry()], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ ok: true, id: "gtin_1", verificationStatus: "verified" }) };
    });
    render(<CatalogReviewTable />);
    await waitFor(() => expect(screen.getByTestId("catalog-review-row-gtin_1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("catalog-review-approve-gtin_1"));

    await waitFor(() => expect(screen.queryByTestId("catalog-review-row-gtin_1")).toBeNull());

    const [, mutationCall] = fetchMock.mock.calls;
    expect(mutationCall[0]).toBe("/api/catalog-review/gtin_1");
    const options = mutationCall[1] as RequestInit;
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string);
    expect(body).toMatchObject({ idToken: "fake-id-token", action: "approve" });
  });

  it("calls the reject API and removes the row from the pending list on success", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/catalog-review?")) {
        return { ok: true, json: async () => ({ entries: [pendingEntry()], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ ok: true, id: "gtin_1", verificationStatus: "rejected" }) };
    });
    render(<CatalogReviewTable />);
    await waitFor(() => expect(screen.getByTestId("catalog-review-row-gtin_1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("catalog-review-reject-gtin_1"));

    await waitFor(() => expect(screen.queryByTestId("catalog-review-row-gtin_1")).toBeNull());

    const [, mutationCall] = fetchMock.mock.calls;
    const body = JSON.parse((mutationCall[1] as RequestInit).body as string);
    expect(body).toMatchObject({ action: "reject" });
  });

  it("keeps the row and shows a row-level error when the action fails", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/catalog-review?")) {
        return { ok: true, json: async () => ({ entries: [pendingEntry()], nextCursor: null }) };
      }
      return { ok: false, json: async () => ({ error: "Failed to update the catalog entry." }) };
    });
    render(<CatalogReviewTable />);
    await waitFor(() => expect(screen.getByTestId("catalog-review-row-gtin_1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("catalog-review-approve-gtin_1"));

    await waitFor(() => expect(screen.getByTestId("catalog-review-row-error-gtin_1")).toBeTruthy());
    expect(screen.getByTestId("catalog-review-row-gtin_1")).toBeTruthy();
  });
});
