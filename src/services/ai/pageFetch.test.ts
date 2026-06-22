import { describe, it, expect, vi } from "vitest";
import {
  barcodeDbUrls,
  htmlToText,
  extractTitleProduct,
  fetchPages,
  enrichWithPageFetch,
  type FetchImpl,
} from "@/services/ai/pageFetch";

function page(html: string) {
  return { ok: true, status: 200, text: async () => html };
}
function notFound() {
  return { ok: false, status: 404, text: async () => "" };
}

const GO_UPC_HTML = `<html><head>
<title>BIC Classic Pocket Lighter Texas | Barcode Lookup</title>
<meta property="og:title" content="BIC Classic Pocket Lighter (Texas)">
</head><body><h1>BIC Classic Pocket Lighter</h1>
<p>UPC-A: 070330645936</p><p>Brand: BIC</p>
<script>var x = 1;</script></body></html>`;

describe("page-fetch building blocks", () => {
  it("builds barcode-database URLs straight from the code", () => {
    const urls = barcodeDbUrls("070330645936");
    expect(urls.some((u) => u.includes("go-upc.com") && u.includes("070330645936"))).toBe(true);
    expect(urls.some((u) => u.includes("upcitemdb.com"))).toBe(true);
  });

  it("strips scripts/styles/tags to readable text", () => {
    const t = htmlToText(GO_UPC_HTML);
    expect(t).toContain("BIC Classic Pocket Lighter");
    expect(t).toContain("070330645936");
    expect(t).not.toContain("<script>");
    expect(t).not.toContain("var x = 1");
  });

  it("extracts a clean product name from og:title / title", () => {
    const p = extractTitleProduct(GO_UPC_HTML);
    expect(p.productName).toBe("BIC Classic Pocket Lighter (Texas)");
  });
});

describe("fetchPages", () => {
  it("fetches and strips pages, skipping failures", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(GO_UPC_HTML) : notFound(),
    ) as unknown as FetchImpl;
    const pages = await fetchPages(barcodeDbUrls("070330645936"), { fetchImpl });
    expect(pages.length).toBe(1);
    expect(pages[0].text).toContain("BIC Classic Pocket Lighter");
  });

  it("on a 429/403 it backs off once then skips politely (does not crash the batch)", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = vi.fn(async () => {
      calls++;
      return { ok: false, status: 429, text: async () => "" };
    }) as unknown as FetchImpl;
    const pages = await fetchPages(["https://go-upc.com/x"], { fetchImpl, backoffMs: 1 });
    expect(pages).toHaveLength(0); // rate-limited -> skipped
    expect(calls).toBe(2); // one retry then give up (polite)
  });

  it("recovers when a 200 arrives after a 429 retry", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 429, text: async () => "" }
        : { ok: true, status: 200, text: async () => "<title>BIC</title> UPC 070330645936" };
    }) as unknown as FetchImpl;
    const pages = await fetchPages(["https://go-upc.com/x"], { fetchImpl, backoffMs: 1 });
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("070330645936");
  });
});

describe("enrichWithPageFetch (the read step)", () => {
  it("confirms the exact code on the page (fetched_source) and extracts the product", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(GO_UPC_HTML) : notFound(),
    ) as unknown as FetchImpl;

    const r = await enrichWithPageFetch({ code: "070330645936", codeType: "upc_a", fetchImpl });
    expect(r.pageCount).toBe(1);
    expect(r.evidence.strength).toBe("fetched_source");
    expect(r.evidence.verified).toBe(true);
    expect(r.result?.productName).toBe("BIC Classic Pocket Lighter (Texas)");
    expect(r.result?.sourceUrls.some((u) => u.includes("go-upc"))).toBe(true);
  });

  it("infers the tire brand from the title when the page has no separate brand field", async () => {
    // Barcode-DB title carries the brand in the name only. Before the fix this left brand="" and blocked
    // the brand-prefix-family corroboration check. The exact code is still verified (fetched_source).
    const html = `<html><head><title>Cooper Discoverer A/T3 LT245/75R16 120R</title></head>
      <body>UPC 029142712886 light truck all-terrain tire in stock</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(html) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "029142712886", codeType: "upc_a", fetchImpl });
    expect(r.evidence.strength).toBe("fetched_source");
    expect(r.evidence.verified).toBe(true);
    expect(r.result?.brand).toBe("Cooper"); // inferred from the title, enabling corroboration
  });

  it("does NOT infer a brand for a non-tire product (poison stays brand-less -> no corroboration)", async () => {
    const html = `<html><head><title>Manstel 200 Pcs Aluminum Core Blind Rivet Screw Kit</title></head>
      <body>UPC 745125495781 hardware</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(html) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "745125495781", codeType: "upc_a", fetchImpl });
    expect(r.result?.brand ?? "").toBe(""); // no known tire brand in the name -> stays empty
  });

  it("matches a UPC-12 even when the page shows the GTIN-13 form", async () => {
    const html = `<html><head><title>PHATOIL Lavender Essential Oil 100ml</title></head>
      <body>GTIN-13: 0697722815261 ... barcode 6977228152610 lavender</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(html) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "6977228152610", codeType: "ean_13", fetchImpl });
    expect(r.evidence.verified).toBe(true);
    expect(r.result?.productName).toContain("PHATOIL");
  });

  it("FAST PATH: uses the page's own structured title first, skipping the model read", async () => {
    const html = `<html><head><meta property="og:title" content="Real Product Name 12oz"></head>
      <body>UPC 070330645936 in stock</body></html>`;
    const extract = vi.fn(async () => ({ productName: "SHOULD NOT BE USED" }));
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(html) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "070330645936", codeType: "upc_a", fetchImpl, extract });
    expect(r.result?.productName).toBe("Real Product Name 12oz");
    expect(extract).not.toHaveBeenCalled(); // heuristic-first: no model call when the page self-describes
  });

  it("reads AI-cited extraUrls, not only the hardcoded barcode DBs (Faire-type fallback)", async () => {
    const faire = `<html><head><meta property="og:title" content="Acrylic Paint Markers Set, 24 Colors"></head>
      <body>UPC 810118139604 - 24 metallic colors</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("faire.com") ? page(faire) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({
      code: "810118139604",
      codeType: "upc_a",
      extraUrls: ["https://www.faire.com/product/p_uxqrb39cyu"],
      fetchImpl,
    });
    expect(r.result?.productName).toContain("Acrylic Paint Markers");
    expect(r.fetchedUrls).toContain("https://www.faire.com/product/p_uxqrb39cyu");
  });

  it("ignores a 'Product Not Found' page that echoes the code; uses a sibling site with the real product", async () => {
    const nf = `<html><head><title>Product Not Found — Go-UPC</title></head>
      <body>Sorry, we were not able to find a product for UPC 810118139604</body></html>`;
    const real = `<html><head><meta property="og:title" content="Acrylic Paint Markers Set, 24 Colors"></head>
      <body>UPC 810118139604 in stock</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(nf) : url.includes("upcitemdb") ? page(real) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "810118139604", codeType: "upc_a", fetchImpl });
    expect(r.result?.productName).toContain("Acrylic Paint Markers");
  });

  it("returns NO product when every site only echoes the code in a 'not found' error", async () => {
    const nf = `<html><head><title>Product Not Found</title></head>
      <body>we were not able to find a product for UPC 810118139604</body></html>`;
    const extract = vi.fn(async () => ({ productName: "SHOULD NOT RUN" }));
    const fetchImpl: FetchImpl = vi.fn(async () => page(nf)) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "810118139604", codeType: "upc_a", fetchImpl, extract });
    expect(r.result).toBeNull();
    expect(extract).not.toHaveBeenCalled(); // don't waste the model read on a not-found page
  });

  it("falls back to the model-read extractor when the page has no usable structured name", async () => {
    // Code is present but the page exposes only a junk/site title -> heuristic yields nothing usable.
    const html = `<html><head><title>Barcode Lookup</title></head><body>UPC 070330645936 found here</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) =>
      url.includes("go-upc") ? page(html) : notFound(),
    ) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({
      code: "070330645936",
      codeType: "upc_a",
      fetchImpl,
      extract: async () => ({ productName: "BIC Classic Pocket Lighter, Texas print", brand: "BIC" }),
    });
    expect(r.result?.productName).toBe("BIC Classic Pocket Lighter, Texas print");
  });

  it("returns NO product when no fetched page contains the exact code (no generic-title fallback)", async () => {
    // A barcode site's GENERIC search page: title is the SITE title, and the code is NOT present.
    const generic = `<html><head><title>UPC Barcode Search — Look up any UPC, EAN, or ISBN</title>
      <meta property="og:title" content="UPC Barcode Search — Look up any UPC, EAN, or ISBN"></head>
      <body>Search for a barcode or product.</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async () => page(generic)) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "710154236681", codeType: "ean_13", fetchImpl });
    expect(r.result).toBeNull(); // must NOT save the website title as a product
  });

  it("extracts the product from ld+json Product schema when the code is on the page", async () => {
    const html = `<html><head><title>Some Store Checkout</title>
      <script type="application/ld+json">{"@type":"Product","name":"PHATOIL Lavender Essential Oil 100ml","brand":{"@type":"Brand","name":"PHATOIL"}}</script>
      </head><body>GTIN-13: 6977228152610</body></html>`;
    const fetchImpl: FetchImpl = vi.fn(async (url: string) => (url.includes("go-upc") ? page(html) : notFound())) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "6977228152610", codeType: "ean_13", fetchImpl });
    expect(r.result?.productName).toContain("PHATOIL Lavender");
    expect(r.evidence.verified).toBe(true);
  });

  it("returns no result (but valid evidence object) when all fetches fail", async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => notFound()) as unknown as FetchImpl;
    const r = await enrichWithPageFetch({ code: "070330645936", codeType: "upc_a", fetchImpl });
    expect(r.pageCount).toBe(0);
    expect(r.result).toBeNull();
    expect(r.evidence.strength).toBe("none");
  });
});
