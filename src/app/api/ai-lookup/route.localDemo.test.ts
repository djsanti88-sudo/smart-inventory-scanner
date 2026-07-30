import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ append: vi.fn(), build: vi.fn(), adminDb: vi.fn(), master: vi.fn() }));
vi.mock("@/server/catalog/masterAppend", () => ({ buildMasterCatalogEntry: mocks.build, appendMasterCatalogEntry: mocks.append }));
vi.mock("@/lib/firebaseAdmin", () => ({ getAdminDb: mocks.adminDb, getAdminAuth: vi.fn() }));
vi.mock("@/server/catalog/masterLookup", () => ({ lookupMasterCatalog: mocks.master }));

import { POST } from "./route";

const original = process.env.SCANBIN_LOCAL_DEMO;
afterEach(() => { vi.clearAllMocks(); if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO; else process.env.SCANBIN_LOCAL_DEMO = original; });
const post = (barcode: string) => POST(new Request("http://localhost/api/ai-lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "decode", rawCode: barcode }) }));

describe("local demo POST has no master/admin side effects", () => {
  it.each(["848983007933", "012345678905"])("settles %s without master append or Admin DB", async (barcode) => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const response = await post(barcode);
    expect(response.status).toBe(200);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.adminDb).not.toHaveBeenCalled();
    expect(mocks.master).not.toHaveBeenCalled();
  });
});
