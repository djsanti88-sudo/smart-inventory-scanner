import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ ladderStorage: vi.fn(), retail: vi.fn(), learned: vi.fn(), master: vi.fn() }));
vi.mock("@/server/upc/storage", () => ({ ladderStorage: seams.ladderStorage }));
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({ lookupRetailBarcodeAsync: seams.retail, getLastRetailLookupStatus: () => "not_called" }));
vi.mock("@/server/learnedProducts", async (original) => ({ ...(await original<typeof import("@/server/learnedProducts")>()), getLearnedProduct: seams.learned }));
vi.mock("@/server/catalog/masterLookup", () => ({ lookupMasterCatalog: seams.master }));
import { runDecodePipeline } from "./pipeline";

const original = process.env.SCANBIN_LOCAL_DEMO;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (original === undefined) delete process.env.SCANBIN_LOCAL_DEMO;
  else process.env.SCANBIN_LOCAL_DEMO = original;
});

describe("local demo decode pipeline", () => {
  it("returns the exact local SQLite identity with a local-only canonical debug id", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const result = await runDecodePipeline({
      code: "848983007933", codeType: "upc_a", rawCodeSanitized: "848983007933", cleanCodeSanitized: "848983007933",
      threshold: 0.8, allowNonPublicAutoCount: false, forceRetry: false,
    });
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.payload.providerNames).toEqual(["local-tire-corpus"]);
    expect(result.payload.decision.status).toBe("verified");
    expect(result.payload.debug.canonicalProductUid).toBe("TIRE_4959A8AD1134FEABF0AC");
    expect(seams.ladderStorage).not.toHaveBeenCalled();
    expect(seams.retail).not.toHaveBeenCalled();
    expect(seams.learned).not.toHaveBeenCalled();
    expect(seams.master).not.toHaveBeenCalled();
  });

  it("returns a storage-free local miss before the normal decode ladder", async () => {
    process.env.SCANBIN_LOCAL_DEMO = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runDecodePipeline({
      code: "012345678905",
      codeType: "upc_a",
      rawCodeSanitized: "012345678905",
      cleanCodeSanitized: "012345678905",
      threshold: 0.8,
      allowNonPublicAutoCount: false,
      forceRetry: false,
    });

    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") return;
    expect(result.payload.decision.status).toBe("needs_review");
    expect(result.payload.reasonCode).toBe("no_result");
    expect(result.payload.providerNames).toEqual(["local-tire-corpus"]);
    expect(result.payload.debug).toMatchObject({
      corroborationPath: "local_demo_corpus_miss",
      ladderPath: "none",
      aiCalled: false,
      pageFetched: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seams.ladderStorage).not.toHaveBeenCalled();
    expect(seams.retail).not.toHaveBeenCalled();
    expect(seams.learned).not.toHaveBeenCalled();
    expect(seams.master).not.toHaveBeenCalled();
  });
});
