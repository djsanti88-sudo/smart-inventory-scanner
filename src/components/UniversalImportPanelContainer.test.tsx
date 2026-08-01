// src/components/UniversalImportPanelContainer.test.tsx
// @vitest-environment jsdom
// Phase 4 Stage A quick-win item 4: loadMapping must throw on a genuine backend failure (401/503)
// instead of silently degrading to "no remembered mapping." GET /api/import-mapping never 404s
// (src/app/api/import-mapping/route.ts:66 always returns 200 with { mapping: record?.mapping ?? null }
// for "no saved mapping"), so the container's loadMapping only needs to branch on response.ok.
//
// Test mode runs in mock auth (NEXT_PUBLIC_AUTH_MODE unset -> isLiveAuth() false), so token() resolves
// undefined without calling getSession - no Firebase auth mocking is needed here.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLocalIdentityPreviewRequest, sha256UploadFile, UniversalImportPanelContainer } from "@/components/UniversalImportPanelContainer";
import { useScanStore } from "@/stores/scanStore";
import type { ColumnMapping, UniversalSheet } from "@/services/importSchema";
import type { Product, Alias } from "@/types";

const getSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

// Real CSV content (the container has no readFile override, so it runs the real
// readUniversalFile -> inferColumnMapping chain; recognizable headers are required to reach
// loadMapping with a real sourceSignature).
const CSV = "Part Number,Brand,Model,Size,Quantity\nABC-1,Acme,Road,225/45R18,7\n";

const REMEMBERED_MAPPING: ColumnMapping = { partNumber: 0, brand: 1, model: 2, size: 3, quantity: 4 };

// Route-aware fetch stub: loadMapping (GET /api/import-mapping) responds per-test via
// `mappingResponse`; matchRows (POST /api/reconcile/match) always returns exactly one
// "review" match per posted row (buildImportPreview throws if match count != row count), so the
// preview build completes without needing real corpus data for this loadMapping-focused test.
function stubFetch(mappingResponse: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes("/api/import-mapping")) {
      return {
        ok: mappingResponse.ok,
        status: mappingResponse.status,
        json: async () => mappingResponse.body,
      };
    }
    if (url.includes("/api/reconcile/match")) {
      const posted = JSON.parse(init?.body ?? "{}") as { rows?: unknown[] };
      const matches = (posted.rows ?? []).map(() => ({
        status: "unmatched",
        reason: "No corpus candidate found.",
        confidence: 0,
      }));
      return { ok: true, status: 200, json: async () => ({ matches }) };
    }
    throw new Error(`Unexpected fetch call in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllEnvs();
  getSession.mockReset().mockResolvedValue({ getIdToken: vi.fn().mockResolvedValue("firebase-token") });
  useScanStore.setState({
    businessId: "biz-test",
    products: [] as Product[],
    aliases: [] as Alias[],
  });
});

describe("UniversalImportPanelContainer - empty businessId (fresh signup, no membership yet)", () => {
  it("hashes original upload bytes with SHA-256 instead of trusting filename and size", async () => {
    const bytes = new TextEncoder().encode("abc");
    const file = { name: "same.csv", size: 3, text: async () => "abc", arrayBuffer: async () => bytes.buffer };
    expect(await sha256UploadFile(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("namespaces barcode evidence and represents held and invalid source rows with collision-safe fingerprints", () => {
    const sheet: UniversalSheet = {
      fileName: "same.xlsx", kind: "xlsx", importedSheetName: "Stock", sheetOrdinal: 2,
      headers: ["Barcode", "Name", "Quantity", "Unit"], rows: [["036000291452", "Tire", "2", "each"], ["", "Held", "3", "box"], ["", "Bad", "", "each"]],
      headerRowIndex: 0, sourceSignature: "same-headers", sourceRowNumbers: [2, 3, 7],
    };
    const request = buildLocalIdentityPreviewRequest({ file: { name: "same.xlsx", size: 123 }, sheets: [sheet], businessId: "biz-test" });
    expect(request.rows).toHaveLength(3);
    expect(request.rows[0]!.identifiers[0]!.namespace).toBe("local-upload");
    expect(new Set(request.rows.map((row) => row.rawRecordFingerprint)).size).toBe(3);
    expect(request.rows.map((row) => row.sourceRowNumber)).toEqual([2, 3, 7]);
  });
  it("renders the local-demo unavailable state without any request", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<UniversalImportPanelContainer />);

    expect(screen.getByTestId("local-demo-import-unavailable")).toHaveTextContent("Import is unavailable in the certified local tire demo.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch /api/import-mapping and does not throw when businessId is empty", async () => {
    // Reproduces the prod 403: a fresh account has no selected/derived businessId yet, but the
    // container used to fire GET /api/import-mapping?businessId= (empty) regardless, and the
    // resulting non-ok response threw the amber "Could not load the remembered column mapping."
    useScanStore.setState({ businessId: "", products: [] as Product[], aliases: [] as Alias[] });
    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("/api/reconcile/match")) {
        const posted = JSON.parse(init?.body ?? "{}") as { rows?: unknown[] };
        const matches = (posted.rows ?? []).map(() => ({ status: "unmatched", reason: "No corpus candidate found.", confidence: 0 }));
        return { ok: true, status: 200, json: async () => ({ matches }) };
      }
      throw new Error(`Unexpected fetch call in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<UniversalImportPanelContainer />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [new File([CSV], "boss.csv")] },
    });

    await waitFor(() => {
      const matchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/reconcile/match"));
      expect(matchCall).toBeDefined();
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/import-mapping"))).toBe(false);
    expect(screen.queryByTestId("import-error")).not.toBeInTheDocument();
  });
});

describe("UniversalImportPanelContainer - loadMapping", () => {
  it("keeps the legacy import selected in production even when the public identity flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    const fetchMock = stubFetch({ ok: true, status: 200, body: { mapping: REMEMBERED_MAPPING } });

    render(<UniversalImportPanelContainer />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File([CSV], "production.csv")] } });

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/reconcile/match"))).toBe(true));
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/identity/preview"))).toBe(false);
    expect(screen.queryByTestId("identity-preview")).not.toBeInTheDocument();
  });

  it("sends businessId and Firebase token to the reconcile match route in live auth mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "live");
    const fetchMock = stubFetch({ ok: true, status: 200, body: { mapping: REMEMBERED_MAPPING } });

    render(<UniversalImportPanelContainer />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [new File([CSV], "boss.csv")] },
    });

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/reconcile/match"))).toBe(true));
    const call = fetchMock.mock.calls.find((item) => String(item[0]).includes("/api/reconcile/match"));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ businessId: "biz-test", idToken: "firebase-token" });
  });

  it("GET returns 200 with { mapping: null } -> resolves null and falls through to column inference (no throw)", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: { mapping: null } });

    render(<UniversalImportPanelContainer />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [new File([CSV], "boss.csv")] },
    });

    // Falls through to manual column mapping (low confidence for this header set is irrelevant here;
    // what matters is no thrown error surfaced and the file was read without an "import-error" alert).
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toContain("/api/import-mapping?");
    expect(screen.queryByTestId("import-error")).not.toBeInTheDocument();
  });

  it("GET returns 401 -> loadMapping throws and the panel surfaces the error, not a silent 'no mapping'", async () => {
    stubFetch({ ok: false, status: 401, body: { error: "Sign in required." } });

    render(<UniversalImportPanelContainer />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [new File([CSV], "boss.csv")] },
    });

    const error = await screen.findByTestId("import-error");
    expect(error).toHaveTextContent("Could not load the remembered column mapping.");
    expect(error).toHaveAttribute("role", "alert");
  });

  it("GET returns 200 with a real mapping -> resolves the mapping unchanged (happy path regression guard)", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, body: { mapping: REMEMBERED_MAPPING } });

    render(<UniversalImportPanelContainer />);
    fireEvent.change(screen.getByTestId("universal-import-file"), {
      target: { files: [new File([CSV], "boss.csv")] },
    });

    // The remembered mapping short-circuits straight to a preview call (matchRows -> POST /api/reconcile/match).
    await waitFor(() => {
      const matchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/reconcile/match"));
      expect(matchCall).toBeDefined();
    });
    expect(screen.queryByTestId("import-error")).not.toBeInTheDocument();
  });
});
