import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { useReconcileStore } from "@/stores/reconcileStore";
import { DEMO_BUSINESS_ID } from "@/seed/seedData";

// Bug class (taskD4-w4-report.md + W3 rerun bonus finding, 2026-08-04/05): a HARD page load
// directly on a protected route (not a client-side nav from an already-loaded page) bypasses
// BusinessContextGate's async wiring, so the page renders/fires businessId-scoped requests while
// scanStore.businessId is still the coded mock default (DEMO_BUSINESS_ID). /reconcile, /products,
// and /settings all read businessId directly (ReconcilePanel's /api/reconcile/match,
// UniversalImportPanelContainer's /api/import-mapping + /api/reconcile/match, and Settings'
// /api/account/delete) but, unlike /scan, /review, /history, and /sessions/[id], none of them wrap
// their content in <BusinessContextGate>. The server's authorize() rejects the wrong-tenant call
// (no data leak) but the feature is functionally broken behind a live-auth deep link or refresh.
//
// Fix: wrap each page's content in the SAME <BusinessContextGate> convention already used by
// scan/review/history/sessions/[id] (see BusinessContextGate.tsx). This test proves the class:
// under live auth + Firebase backend with the business context not yet hydrated, the gated pages
// must show the loading gate instead of their real content, and must fire no request.

vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  getSelectedBusinessId: () => "biz-real",
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  // Never resolves during the test: BusinessContextGate must stay in its "resolving" state the
  // whole time, the same window a hard page load spends before the real business context lands.
  getSession: vi.fn(() => new Promise(() => {})),
  listMemberships: vi.fn().mockResolvedValue([]),
  // Settings' own unrelated auth-state listener (unsubscribe-returning, Firebase onAuthStateChanged
  // shape) - not part of the gate under test, just needs to exist so SettingsPage can mount.
  onAuthChange: vi.fn(() => () => {}),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasLegacyBlob: () => false,
  persistKeyForUid: (uid: string | null) => (uid ? `sis-scan-${uid}` : "sis-scan-v1"),
}));

import ReconcilePage from "./reconcile/page";
import ProductsPage from "./products/page";
import SettingsPage from "./settings/page";
import ReportPage from "./report/page";
import CatalogReviewPage from "./catalog-review/page";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
  useScanStore.setState({
    businessId: DEMO_BUSINESS_ID,
    businessContextReady: false,
    businessDataLoaded: false,
  });
  useReconcileStore.setState({ _hasHydrated: true, session: null, matches: null, report: null, unitCosts: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "reconcile", Page: ReconcilePage, contentTestId: "reconcile-empty-state" },
  { name: "products", Page: ProductsPage, contentTestId: "products-body" },
  { name: "settings", Page: SettingsPage, contentTestId: "clear-cache" },
  { name: "report", Page: ReportPage, contentTestId: "boss-report-body" },
  // catalog-review is INTENTIONALLY excluded from this gated list - see the dedicated describe block
  // below (Codex final verdict, 2026-08-05, finding 4 - final ruling).
])("$name route: business-context gate (same class as the reconcile 403)", ({ Page, contentTestId }) => {
  it("shows the business-context loading gate instead of page content, and fires no request scoped to the stale demo-business id", () => {
    render(<Page />);
    // The gate must be showing (children withheld) - not the real page content, which could fire a
    // businessId-scoped request while businessId is still the demo-business default.
    expect(screen.queryByTestId("business-loading")).toBeInTheDocument();
    expect(screen.queryByTestId(contentTestId)).not.toBeInTheDocument();
    // Some pages (e.g. Settings, like /scan) legitimately poll a non-tenant-scoped endpoint
    // (/api/ai-lookup status) outside the gate - that is fine. What must never happen is any
    // request carrying the stale mock-default businessId while the real tenant is still resolving.
    const calls = vi.mocked(global.fetch).mock.calls;
    const leaked = calls.some(([url, init]) => {
      const urlStr = String(url);
      const bodyStr = init && "body" in init && init.body ? String(init.body) : "";
      return urlStr.includes(DEMO_BUSINESS_ID) || bodyStr.includes(DEMO_BUSINESS_ID);
    });
    expect(leaked).toBe(false);
  });
});

// Stronger, scenario-specific reproduction of the exact reported bug: a reconcile session is
// already imported (as it would be after a hard reload mid-session) so "Run compare" would be
// reachable the instant the gate is bypassed. Prove the button is not even reachable, so the
// wrong-tenant request structurally cannot be sent.
describe("reconcile: hard-load reproduction with an already-imported session", () => {
  it("never renders 'Run compare' and never POSTs /api/reconcile/match with the stale demo-business id", () => {
    useReconcileStore.setState({
      _hasHydrated: true,
      session: {
        fileName: "shopware.csv",
        importedAt: "2026-08-04T00:00:00.000Z",
        adapter: {
          rows: [{ externalId: "PN1", partNumbers: ["PN1"], brand: "Cooper", sizeText: "265/70R17", qty: 6, raw: {} }],
          uomReview: [],
          unparseable: [],
          assumptions: [],
        },
      },
      matches: null,
      report: null,
    });

    render(<ReconcilePage />);

    expect(screen.queryByTestId("reconcile-run")).not.toBeInTheDocument();
    expect(screen.queryByTestId("business-loading")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// catalog-review: DELIBERATELY the ODD ONE OUT among the routes above (Codex final verdict, 2026-08-05,
// finding 4 - final ruling). It was briefly wrapped in BusinessContextGate "for consistency" with the
// other protected routes, but CatalogReviewTable never reads/sends businessId - it is a cross-tenant,
// platform-owner-only resource authorized server-side via the Firebase id token only (see
// CatalogReviewTable.tsx). BusinessContextGate's "no-business" branch requires a SELECTED business
// membership, so wrapping it there wrongly locked out a correctly authenticated platform owner who has
// not selected a shop. The final ruling reverted the wrapper: this page must render its real (gated only
// by useIsPlatformOwner) content immediately, under live auth, with no business context set up at all -
// never the "business-loading" wait the other four routes above require.
describe("catalog-review: intentionally UNGATED by BusinessContextGate (business-agnostic platform-owner admin page)", () => {
  it("renders its own content immediately under live auth with no selected business, never the business-context loading gate", () => {
    render(<CatalogReviewPage />);
    // No BusinessContextGate wrapper: the page's real content (platform-owner-only CatalogReviewTable,
    // which itself shows the "forbidden" branch for a non-platform-owner test identity) renders right
    // away - the shared "business-loading" gate must never appear here.
    expect(screen.queryByTestId("business-loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("catalog-review-forbidden")).toBeInTheDocument();
  });
});
