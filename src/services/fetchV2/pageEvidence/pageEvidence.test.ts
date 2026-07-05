import { describe, expect, test } from "vitest";
import { evaluatePageJunk } from "./junkRules";
import { extractProducts } from "./extract";
import { proveAssociation } from "./association";

const CODE = "028400325042";

// ------------------------------------------------------------------ junk rules (dry-run failures)
describe("evaluatePageJunk", () => {
  const cases: Array<[string, { url: string; title: string; text?: string }]> = [
    ["title is only the code", { url: "https://x.com/p/1", title: CODE }],
    ["Search For: echo", { url: "https://barcode-list.com/barcode/EN/Search.htm?barcode=" + CODE, title: `Search For: ${CODE}` }],
    ["UPC Database | code echo", { url: "https://www.upcdatabase.com/item/" + CODE, title: `UPC Database | ${CODE}` }],
    ["German search results", { url: "https://www.codecheck.info/product.search?q=" + CODE, title: "CodeCheck - Suchergebnisse" }],
    ["not-found page", { url: "https://go-upc.com/search?q=" + CODE, title: "Go-UPC", text: `Sorry, we were not able to find a product for UPC ${CODE}` }],
    ["nutrition recycled-UPC page", { url: "https://nutridb.example.com/upc/" + CODE, title: `Nutrition facts for ${CODE}`, text: "nutrition facts and analysis for many products sharing this code" }],
  ];

  test.each(cases)("hard-rejects: %s", (_label, page) => {
    const v = evaluatePageJunk(page, CODE);
    expect(v.rejected).toBe(true);
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  test("accepts a real product page", () => {
    const v = evaluatePageJunk(
      { url: "https://www.walmart.com/ip/doritos-cool-ranch/17248848", title: "Doritos Cool Ranch Flavored Tortilla Chips, 9.25 oz Bag", text: `Doritos Cool Ranch. UPC ${CODE}. Crunchy tortilla chips.` },
      CODE,
    );
    expect(v.rejected).toBe(false);
  });

  test("rejects when the code appears ONLY in the URL", () => {
    const v = evaluatePageJunk(
      { url: `https://shop.example.com/item/${CODE}`, title: "Some Product Name", text: "A product page that never mentions the scanned code in its content." },
      CODE,
    );
    expect(v.rejected).toBe(true);
    expect(v.reasons.join(" ")).toMatch(/url/i);
  });
});

// ------------------------------------------------------------------ structured extraction
const JSON_LD_PAGE = `<!doctype html><html><head>
<title>Doritos Cool Ranch Flavored Tortilla Chips, 9.25 oz - Walmart.com</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Doritos Cool Ranch Flavored Tortilla Chips, 9.25 oz Bag",
 "brand":{"@type":"Brand","name":"Doritos"},"gtin13":"0028400325042","sku":"17248848",
 "description":"Bold Cool Ranch flavor.","image":"https://i5.walmartimages.com/dor.jpg"}
</script></head><body>Doritos page</body></html>`;

const TABLE_PAGE = `<html><head><title>Toyo Proxes R888R 255/40ZR17 - Tire Store</title></head><body>
<h1>Toyo Proxes R888R</h1>
<table class="specs"><tr><th>Brand</th><td>Toyo</td></tr>
<tr><th>UPC</th><td>4981910515661</td></tr><tr><th>Size</th><td>255/40ZR17</td></tr></table>
</body></html>`;

const OG_ONLY_PAGE = `<html><head><title>Great Product - Shop</title>
<meta property="og:title" content="Great Product 12 oz"/></head><body>no structure</body></html>`;

describe("extractProducts", () => {
  test("JSON-LD Product wins with gtin + brand + name", () => {
    const products = extractProducts(JSON_LD_PAGE);
    const p = products.find((x) => x.source === "json_ld");
    expect(p).toBeDefined();
    expect(p!.name).toContain("Doritos Cool Ranch");
    expect(p!.brand).toBe("Doritos");
    expect(p!.gtins).toContain("0028400325042");
    expect(p!.sku).toBe("17248848");
  });

  test("detail-table UPC row is extracted with the page h1/title identity", () => {
    const products = extractProducts(TABLE_PAGE);
    const p = products.find((x) => x.source === "detail_table");
    expect(p).toBeDefined();
    expect(p!.gtins).toContain("4981910515661");
    expect(p!.name.toLowerCase()).toContain("proxes r888r");
  });

  test("OG title is extracted ONLY as a flagged fallback", () => {
    const products = extractProducts(OG_ONLY_PAGE);
    expect(products.every((p) => p.source === "og_title")).toBe(true);
    expect(products[0]?.gtins ?? []).toHaveLength(0);
  });

  test("malformed JSON-LD does not throw and yields nothing structured", () => {
    const products = extractProducts(`<script type="application/ld+json">{not json]</script>`);
    expect(products.filter((p) => p.source === "json_ld")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ association proof
describe("proveAssociation", () => {
  const variants = ["028400325042", "0028400325042", "00028400325042"];

  test("STRONG: variant matches JSON-LD gtin field", () => {
    const products = extractProducts(JSON_LD_PAGE);
    const proof = proveAssociation(variants, products, "irrelevant body text", "https://www.walmart.com/ip/x");
    expect(proof.level).toBe("strong");
    expect(proof.matchedField).toContain("json_ld");
    expect(proof.product?.brand).toBe("Doritos");
  });

  test("STRONG: variant matches a detail-table gtin", () => {
    const products = extractProducts(TABLE_PAGE);
    const proof = proveAssociation(["4981910515661"], products, "", "https://tires.example.com/p/1");
    expect(proof.level).toBe("strong");
  });

  test("WEAK: code only somewhere in page text, no structured tie", () => {
    // Updated for the barcode-label-context rule (task 1, 2026-07-05): a bare floating number is no
    // longer evidence, so the fixture now carries a label ("UPC") to keep testing the intended
    // behavior (weak page_text tie, no structured product record).
    const proof = proveAssociation(variants, [], `random blog mentioning UPC ${CODE} once`, "https://blog.example.com/post");
    expect(proof.level).toBe("weak");
    expect(proof.matchedField).toBe("page_text");
  });

  test("NONE: code only in the URL is not evidence", () => {
    const proof = proveAssociation(variants, [], "text without the code", `https://shop.example.com/item/${CODE}`);
    expect(proof.level).toBe("none");
    expect(proof.matchedField).toBe("url_only");
  });

  test("NONE: code nowhere", () => {
    const proof = proveAssociation(variants, [], "nothing relevant", "https://x.example.com/");
    expect(proof.level).toBe("none");
  });

  test("codes under 10 digits never form WEAK page-text associations (garbage collisions)", () => {
    // Live: 8-digit retail codes matched a pest-control page and a court filing via body text.
    const proof = proveAssociation(["11472292"], [], "order item 11472292 today", "https://x.example.com/p");
    expect(proof.level).toBe("none");
  });

  test("codes under 10 digits CAN still match structured gtin fields (strong path unaffected)", () => {
    const p = { source: "json_ld" as const, name: "Nestea Iced Tea Peach", brand: "Nestea", gtins: ["11472292"], sku: "", description: "", imageUrl: "" };
    const proof = proveAssociation(["11472292"], [p], "", "https://shop.example.com/p");
    expect(proof.level).toBe("strong");
  });

  test("digit boundaries: variant must not match inside a longer number", () => {
    const proof = proveAssociation(["12345678"], [], "part 9912345678001 is different", "https://x.example.com/");
    expect(proof.level).toBe("none");
  });

  test("an echoed code in a table on a search-style URL is WEAK, never strong (canary breach)", () => {
    const products = extractProducts(`<html><body><h1>Euro to US Dollar</h1><table><tr><th>UPC</th><td>749000000022</td></tr></table></body></html>`);
    const proof = proveAssociation(["749000000022"], products, "", "https://go-upc.example.com/search?q=749000000022");
    expect(proof.level).not.toBe("strong");
  });

  test("a detail-table gtin on a NON-search URL stays strong", () => {
    const products = extractProducts(`<html><body><h1>Toyo Proxes R888R</h1><table><tr><th>UPC</th><td>4981910515661</td></tr></table></body></html>`);
    const proof = proveAssociation(["4981910515661"], products, "", "https://tires.example.com/product/toyo-r888r");
    expect(proof.level).toBe("strong");
  });

  test("page_text matches REQUIRE barcode-label context (bare numbers are not evidence)", () => {
    const bare = proveAssociation(["4981910515661"], [], "our warehouse moved 4981910515661 boxes last year", "https://x.example.com/");
    expect(bare.level).toBe("none");
    const labeled = proveAssociation(["4981910515661"], [], "Specifications: UPC 4981910515661, made in Japan", "https://x.example.com/");
    expect(labeled.level).toBe("weak");
    expect(labeled.matchedField).toBe("page_text");
  });

  test("negative context disqualifies a match even with digits present", () => {
    const p = proveAssociation(["4981910515661"], [], "MLS listing no. 4981910515661 - 3bd 2ba ranch", "https://mls.example.com/");
    expect(p.level).toBe("none");
    const p2 = proveAssociation(["4981910515661"], [], "invoice 4981910515661 due net 30", "https://acct.example.com/");
    expect(p2.level).toBe("none");
  });
});
