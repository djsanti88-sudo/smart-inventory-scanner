import { describe, expect, test, vi } from "vitest";
import { detectSiblingAmbiguity, identityRelation } from "./siblingGuard";
import { scoreSource, decideOutcome, type SourceFinding } from "./scoring";
import { FetchV2Cache } from "./cache";
import { braveProvider, firecrawlSearchProvider, type MinimalFetch } from "./sources/discovery";
import { fetchV2, type FetchV2Deps } from "./index";
import { classifyIdentifier } from "./classify";
import type { AssociationProof } from "./pageEvidence/association";

const CODE = "028400325042";

// ---------------------------------------------------------------------------- sibling guard
describe("detectSiblingAmbiguity", () => {
  test("same brand, different flavor => ambiguous", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "Doritos" },
      { name: "Doritos Nacho Cheese Tortilla Chips 9.25 oz", brand: "Doritos" },
    ]);
    expect(v.ambiguous).toBe(true);
  });

  test("same product, different size => ambiguous", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "Doritos" },
      { name: "Doritos Cool Ranch Tortilla Chips 15.5 oz", brand: "Doritos" },
    ]);
    expect(v.ambiguous).toBe(true);
    expect(v.reason).toMatch(/size|variant/i);
  });

  test("same tire model, different tire size => ambiguous", () => {
    const v = detectSiblingAmbiguity([
      { name: "Toyo Proxes R888R 255/40ZR17", brand: "Toyo" },
      { name: "Toyo Proxes R888R 265/35ZR18", brand: "Toyo" },
    ]);
    expect(v.ambiguous).toBe(true);
  });

  test("UNRELATED products with missing brands are NOT siblings (live bug: water vs video game)", () => {
    const v = detectSiblingAmbiguity([
      { name: "Member's Mark PURIFIED WATER", brand: "" },
      { name: "Shin Megami Tensei: Digital Devil Saga [Deluxe Box] - PlayStation 2", brand: "" },
    ]);
    expect(v.ambiguous).toBe(false);
  });

  test("same family with missing brands but different sizes is STILL a sibling", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "" },
      { name: "Doritos Cool Ranch Tortilla Chips 15.5 oz", brand: "" },
    ]);
    expect(v.ambiguous).toBe(true);
  });

  test("name CONTAINMENT is agreement, not conflict (the 5 false-conflict live rows)", () => {
    const pairs: Array<[string, string]> = [
      ["Beef Chunks", "Grabill Country Meats Beef Chunks, 27 oz"],
      ["Crepiotella", "Crepiotella – Crepiote"],
      ["Rainbow Cherry", "Rainbow Cherry – Squire Boone Village – 0.75 oz (22 g)"],
      ["Triple berry blend blackberries, raspberries, blueberries, triple berry blend", "Harris Teeter™ Triple berry blend"],
    ];
    for (const [a, b] of pairs) {
      const v = detectSiblingAmbiguity([{ name: a, brand: "" }, { name: b, brand: "" }]);
      expect(v.ambiguous, `${a} vs ${b}`).toBe(false);
    }
  });

  test("a pipe suffix carrying a tire size is a VARIANT LIST, not a site tail (Toyo live flip, v2.3 batch 8)", () => {
    // DiscountTire titles list size variants after "|"; stripping the pipe suffix deleted the very
    // size that agreed with the other listing and the pair was called unrelated.
    expect(identityRelation(
      { name: "Toyo Tire Extensa HP II 225 /35 R20 90W XL BSW | 275 /35 R20 ...", brand: "" },
      { name: "275/35R20 102W XL Toyo Extensa HPII - Evasive Motorsports", brand: "" },
    )).toBe("agree");
  });

  test("a LONG dash suffix is the product name, not a marketplace tail (Cooper CARiD live flip, v2.3 batch 8)", () => {
    // CARiD format is "BRAND(R) SKU - PRODUCT NAME": the digit-free dash strip ate the identity.
    expect(identityRelation(
      { name: "Cooper Discoverer Stronghold AT LT265/75R16 123/120S 10 BW ...", brand: "" },
      { name: "COOPER TIRES® 170276047 - DISCOVERER STRONGHOLD AT ...", brand: "" },
    )).not.toBe("unrelated");
  });

  test("short marketplace tails after dash/pipe are still stripped (no regression)", () => {
    expect(identityRelation(
      { name: "Pirelli Cinturato P7 245/40R19 98Y - Walmart.com", brand: "" },
      { name: "Pirelli Cinturato P7 245/40R19", brand: "" },
    )).toBe("agree");
  });

  test("generic tire vocabulary is NOT a distinctive shared token: different brands, same size = UNRELATED (final-review Critical)", () => {
    // The recycled-code fence must not be satisfiable by the word "Tire": two different brands of
    // the same size are different products even though every tire listing says "Tire".
    expect(identityRelation(
      { name: "Michelin Pilot Sport 4 245/35R19 Tire", brand: "" },
      { name: "Continental ExtremeContact DWS06 245/35R19 Tire", brand: "" },
    )).toBe("unrelated");
    expect(identityRelation(
      { name: "Goodyear Eagle F1 245/35R19 Tire", brand: "" },
      { name: "Pirelli P Zero 245/35R19 Tire", brand: "" },
    )).toBe("unrelated");
    // Same actual product still agrees through a REAL shared token (brand/model).
    expect(identityRelation(
      { name: "Michelin Pilot Sport 4 245/35R19 Tire", brand: "" },
      { name: "245/35R19 Michelin Pilot Sport 4 XL", brand: "" },
    )).toBe("agree");
  });

  test("containment cannot merge numeric variants: differing pure-number tokens are siblings (final-review Important)", () => {
    expect(identityRelation(
      { name: "Bosch Icon Wiper Blade 26", brand: "" },
      { name: "Bosch Icon Wiper Blade 22", brand: "" },
    )).toBe("sibling");
    expect(identityRelation(
      { name: "Nike Air Max 90 size 10", brand: "" },
      { name: "Nike Air Max 95 size 10", brand: "" },
    )).toBe("sibling");
    // Full containment with NO numeric mismatch still agrees (Grabill class must not regress).
    expect(identityRelation(
      { name: "Beef Chunks", brand: "" },
      { name: "Grabill Country Meats Beef Chunks", brand: "" },
    )).toBe("agree");
  });

  test("motorcycle dash-notation sizes agree with R notation (ContiGO live flip, v2.3 batch 9)", () => {
    // 100/80-17 IS 100/80R17: the dash is the universal motorcycle-tire separator. The fitment
    // vehicle tokens (MBK X-Limit) must not drown the size+brand agreement.
    expect(identityRelation(
      { name: "MBK X-Limit Supermoto 50 Front Tyre 100/80-17 Continental ContiGo!", brand: "" },
      { name: "Continental ContiGO 100/80R17 52P from Annan Tyres", brand: "" },
    )).toBe("agree");
  });

  test("brand-family name forms are compatible, not a brand conflict (Grabill live flip, v2.3 batch 3)", () => {
    // One company, many brand-name forms ("Grabill Country" / "Grabill Country Meat(s)"). The old
    // exact-string brand gate returned "unrelated" before name containment could ever run.
    expect(identityRelation(
      { name: "Beef Chunks", brand: "Grabill Country Meat" },
      { name: "Grabill Country Meats Beef Chunks, 27 oz", brand: "Grabill Country" },
    )).toBe("agree");
    expect(identityRelation(
      { name: "Beef Chunks", brand: "Grabill" },
      { name: "Grabill Country Meats Beef Chunks, 27 oz", brand: "Grabill Country Meats" },
    )).toBe("agree");
  });

  test("genuinely DISJOINT brands still conflict even with similar names", () => {
    expect(identityRelation(
      { name: "Beef Chunks 27 oz", brand: "Kroger" },
      { name: "Beef Chunks, 27 oz", brand: "Grabill Country Meat" },
    )).toBe("unrelated");
  });

  test("grams-serving vs oz-pack is NOT a size conflict (Mt Olive live row)", () => {
    const v = detectSiblingAmbiguity([
      { name: "Mt Olive Hot Banana Pepper Rings, 12 oz", brand: "" },
      { name: "Hot Banana Pepper Rings – Mt. Olive – 28 g", brand: "" },
    ]);
    expect(v.ambiguous).toBe(false);
  });

  test("tire size with X separator equals slash notation (Falken live row)", () => {
    const v = detectSiblingAmbiguity([
      { name: "falken wildpeak a t trail 215/65R16", brand: "" },
      { name: "Falken 215X65R16XL Wildpeak A/T Trail BSW", brand: "" },
    ]);
    expect(v.ambiguous).toBe(false);
  });

  test("REAL same-unit size conflicts still trip the guard", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "" },
      { name: "Doritos Cool Ranch Tortilla Chips 15.5 oz", brand: "" },
    ]);
    expect(v.ambiguous).toBe(true);
  });

  test("tire results with the SAME size and shared model agree despite A/T3W-vs-AT3W and site suffixes (200-run live bug)", () => {
    const pairs: Array<[string, string]> = [
      ["Tire Falken Wildpeak A/T3W 265/70R17 115T AT All Terrain | eBay", "Falken Wildpeak AT3W Tires - 265/70R17 - 28034300"],
      ["Yokohama Parada Spec-X Tire - 315/35R24 114V – RV & Auto Parts", "4 New Yokohama Parada Spec-x - 315/35r24 Tires 3153524 315 35 24 | eBay"],
    ];
    for (const [a, b] of pairs) {
      expect(identityRelation({ name: a, brand: "" }, { name: b, brand: "" }), `${a} || ${b}`).toBe("agree");
    }
  });

  test("ST-prefixed trailer sizes parse: two identical Goodride listings AGREE (forensic live bug)", () => {
    expect(identityRelation(
      { name: "Tire Goodride ST100 Steel Belted ST 225/75R15 Load E 10 Ply Trailer | eBay", brand: "" },
      { name: "2 New Goodride St100 - St225/75r15 Tires 2257515 225 75 15 | eBay", brand: "" },
    )).toBe("agree");
  });

  test("apostrophes, Z-speed ratings, and decimal rims canonicalize: Nexen and BFGoodrich pairs AGREE", () => {
    expect(identityRelation(
      { name: "4 New 255/45ZR18 Nexen N'Fera AU7 Tire 2554518 | eBay", brand: "" },
      { name: "Nexen NFera AU7 255/45R18 99W BSW (1 Tires)", brand: "" },
    )).toBe("agree");
    expect(identityRelation(
      { name: "BFGoodrich DR454 275/80R22.5 Drive Radial Tire", brand: "" },
      { name: "275/80R22.5 BFGoodrich DR454 Commercial Truck Tire", brand: "" },
    )).toBe("agree");
  });

  test("multi-size titles are size-AMBIGUOUS, not size-conflicting (Uniroyal live row)", () => {
    expect(identityRelation(
      { name: "Uniroyal Power Paw A/S 215 /40 R18 89Y XL BSW | 225 /40 R18 92Y", brand: "" },
      { name: "Uniroyal Power Paw A/S 225/40R18", brand: "" },
    )).toBe("agree");
  });

  test("XL/speed-rating suffixes never break size agreement", () => {
    expect(identityRelation(
      { name: "Pirelli P Zero Trofeo R 245/35ZR19XL 93Y", brand: "" },
      { name: "Pirelli P Zero Trofeo R 245/35R19", brand: "" },
    )).toBe("agree");
  });

  // Regression lock for the XL-strip regex itself: the shared MODEL token ("Trailmax") satisfies
  // the tire branch's distinctive-token requirement, but without the XL strip side A's glued
  // "245/35ZR19XL" never parses as a size, no tire agreement fires, and containment (0.5),
  // leading-prefix (uncontained mid-run), and jaccard (0.2) all fall short - so the XL-stripped
  // size is the deciding signal. (Original fixture shared only generic "Tire"/"Performance"
  // words; the final-review Critical rightly made generic tire vocabulary non-distinctive, so
  // the fixture was rebuilt with a real model token.)
  test("XL-stripped tire size is the ONLY shared signal (containment/jaccard alone cannot rescue this)", () => {
    expect(identityRelation(
      { name: "Trailmax Sport GT-A 245/35ZR19XL 93Y", brand: "" },
      { name: "245/35R19 Trailmax Radial", brand: "" },
    )).toBe("agree");
  });

  // Regression protection for the multi-size ambiguity lens (sizesConflict): confirms the branch
  // actually discriminates on shared-vs-unshared sizes, not just "multi-size => always agree".
  test("multi-size titles: a shared size still agrees, but NO shared size is a real clash", () => {
    expect(identityRelation(
      { name: "Uniroyal Power Paw A/S 215/40R18 225/40R18", brand: "" },
      { name: "Uniroyal Power Paw A/S 225/40R18", brand: "" },
    )).toBe("agree");
    expect(identityRelation(
      { name: "Uniroyal Power Paw A/S 215/40R18 235/40R18", brand: "" },
      { name: "Uniroyal Power Paw A/S 225/40R18", brand: "" },
    )).toBe("sibling");
  });

  test("agreeing identities are NOT ambiguous (case/punctuation ignored)", () => {
    const v = detectSiblingAmbiguity([
      { name: "Doritos Cool Ranch Flavored Tortilla Chips, 9.25 oz Bag", brand: "Doritos" },
      { name: "DORITOS Cool Ranch Tortilla Chips 9.25oz", brand: "Doritos" },
    ]);
    expect(v.ambiguous).toBe(false);
  });

  test("single candidate is never ambiguous", () => {
    expect(detectSiblingAmbiguity([{ name: "Anything", brand: "X" }]).ambiguous).toBe(false);
  });
});

// ---------------------------------------------------------------------------- scoring
const strongAssoc: AssociationProof = { level: "strong", matchedVariant: CODE, matchedField: "json_ld.gtin", product: null };
const weakAssoc: AssociationProof = { level: "weak", matchedVariant: CODE, matchedField: "page_text", product: null };
const noAssoc: AssociationProof = { level: "none", matchedVariant: "", matchedField: "", product: null };

describe("scoreSource", () => {
  test("major retailer + strong association => strong quality", () => {
    const s = scoreSource("https://www.walmart.com/ip/doritos/17248848", strongAssoc, false);
    expect(s.quality).toBe("strong");
    expect(s.score).toBeGreaterThanOrEqual(70);
  });

  test("junk-rejected page is always rejected quality, score 0", () => {
    const s = scoreSource("https://www.walmart.com/ip/x", strongAssoc, true);
    expect(s.quality).toBe("rejected");
    expect(s.score).toBe(0);
  });

  test("unknown host + weak association => weak", () => {
    const s = scoreSource("https://random-blog.example.net/post", weakAssoc, false);
    expect(s.quality).toBe("weak");
  });

  test("barcode DB (supporting tier) + strong association => medium", () => {
    const s = scoreSource("https://go-upc.com/search?q=" + CODE, strongAssoc, false);
    expect(s.quality).toBe("medium");
  });
});

// ---------------------------------------------------------------------------- outcome decisions
const pubId = classifyIdentifier(CODE);
const doritos = { source: "json_ld" as const, name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "Doritos", gtins: ["0028400325042"], sku: "", description: "", imageUrl: "" };

function finding(over: Partial<SourceFinding>): SourceFinding {
  return { url: "https://www.walmart.com/ip/x", association: strongAssoc, product: doritos, junkRejected: false, junkReasons: [], quality: "strong", score: 85, ...over };
}

describe("decideOutcome (balanced)", () => {
  test("strong source + strong association => verified", () => {
    const d = decideOutcome(pubId, [finding({})], "balanced");
    expect(d.outcome).toBe("verified");
    expect(d.confidence).toBeGreaterThanOrEqual(0.8);
    expect(d.winner?.url).toContain("walmart");
  });

  test("single MEDIUM source alone does NOT verify in balanced", () => {
    const d = decideOutcome(pubId, [finding({ quality: "medium", score: 55, url: "https://go-upc.com/search?q=" + CODE })], "balanced");
    expect(d.outcome).toBe("suggested");
  });

  test("two independent medium sources that AGREE => verified", () => {
    const d = decideOutcome(pubId, [
      finding({ quality: "medium", score: 55, url: "https://go-upc.com/search?q=" + CODE }),
      finding({ quality: "medium", score: 55, url: "https://world.openfoodfacts.org/product/0" + CODE }),
    ], "balanced");
    expect(d.outcome).toBe("verified");
  });

  test("two sources with SIBLING identities => needs_review, never verified", () => {
    const nacho = { ...doritos, name: "Doritos Nacho Cheese Tortilla Chips 9.25 oz" };
    const d = decideOutcome(pubId, [
      finding({}),
      finding({ url: "https://www.target.com/p/x", product: nacho }),
    ], "balanced");
    expect(d.outcome).toBe("needs_review");
    expect(d.conflicts.length).toBeGreaterThan(0);
  });

  test("a WEAK-association junk-collision page cannot veto a strong verified finding (live bug)", () => {
    const game = { source: "og_title" as const, name: "Shin Megami Tensei Deluxe Box PlayStation 2", brand: "", gtins: [], sku: "", description: "", imageUrl: "" };
    const d = decideOutcome(pubId, [
      finding({}), // strong walmart + strong association + doritos identity
      finding({ url: "https://thevideogamecavern.example.com/p/1", association: weakAssoc, quality: "weak", score: 30, product: game }),
    ], "balanced");
    expect(d.outcome).toBe("verified");
  });

  test("two STRONG-association sources naming UNRELATED products = recycled-code conflict => needs_review", () => {
    const game = { source: "json_ld" as const, name: "Shin Megami Tensei Deluxe Box PlayStation 2", brand: "Atlus", gtins: ["0028400325042"], sku: "", description: "", imageUrl: "" };
    const d = decideOutcome(pubId, [
      finding({}),
      finding({ url: "https://games.example.com/p/1", quality: "medium", score: 55, product: game }),
    ], "balanced");
    expect(d.outcome).toBe("needs_review");
    expect(d.conflicts.length).toBeGreaterThan(0);
  });

  test("two medium sources that DISAGREE on identity do NOT corroborate a verify", () => {
    const other = { ...doritos, name: "Charmin Ultra Soft Toilet Paper 12 Mega Rolls", brand: "Charmin" };
    const d = decideOutcome(pubId, [
      finding({ quality: "medium", score: 55, url: "https://go-upc.com/search?q=" + CODE }),
      finding({ quality: "medium", score: 55, url: "https://world.openfoodfacts.org/product/0" + CODE, product: other }),
    ], "balanced");
    expect(d.outcome).not.toBe("verified");
  });

  test("suggestion winner is the MOST INFORMATIVE candidate, not the first inserted (CAMPBELL bug)", () => {
    const short = { ...doritos, name: "CAMPBELL", brand: "" };
    const full = { ...doritos, name: "Campbell's Condensed Cream of Chicken Soup 22.6 oz", brand: "Campbell's" };
    const d = decideOutcome(pubId, [
      finding({ association: weakAssoc, quality: "weak", score: 30, product: short, url: "https://a.example.com/1" }),
      finding({ association: weakAssoc, quality: "weak", score: 30, product: full, url: "https://b.example.com/2" }),
    ], "balanced");
    expect(d.outcome).toBe("suggested");
    expect(d.winner?.product?.name).toContain("Cream of Chicken");
  });

  test("weak association only => suggested, never verified", () => {
    const d = decideOutcome(pubId, [finding({ association: weakAssoc, quality: "weak", score: 30 })], "balanced");
    expect(d.outcome).toBe("suggested");
  });

  test("only junk-rejected findings => rejected", () => {
    const d = decideOutcome(pubId, [finding({ junkRejected: true, quality: "rejected", score: 0, association: noAssoc, product: null })], "balanced");
    expect(d.outcome).toBe("rejected");
  });

  test("no findings at all => unknown", () => {
    expect(decideOutcome(pubId, [], "balanced").outcome).toBe("unknown");
  });

  test("non-public identifier can NEVER be verified even with strong findings", () => {
    const asin = classifyIdentifier("B09B8V1LZ3");
    const d = decideOutcome(asin, [finding({})], "balanced");
    expect(d.outcome).not.toBe("verified");
  });
});

describe("decideOutcome (strict vs fast)", () => {
  test("strict demands corroboration: one strong source alone => suggested", () => {
    const d = decideOutcome(pubId, [finding({})], "strict");
    expect(d.outcome).toBe("suggested");
  });

  test("strict verifies with strong + agreeing second source", () => {
    const d = decideOutcome(pubId, [
      finding({}),
      finding({ quality: "medium", score: 55, url: "https://world.openfoodfacts.org/product/0" + CODE }),
    ], "strict");
    expect(d.outcome).toBe("verified");
  });

  test("fast verifies a single strong source, same as balanced", () => {
    expect(decideOutcome(pubId, [finding({})], "fast").outcome).toBe("verified");
  });
});

// ---------------------------------------------------------------------------- cache
describe("FetchV2Cache", () => {
  test("verified results round-trip by primary", async () => {
    const cache = new FetchV2Cache();
    const r = await fetchV2(CODE, { fetchPage: async () => ({ ok: false, status: 404, html: "" }), discovery: [] });
    cache.saveVerified(CODE, r);
    expect(cache.getVerified(CODE)).toBe(r);
    expect(cache.getVerified("other")).toBeUndefined();
  });

  test("bad URLs are remembered with a reason and expire after TTL", () => {
    let t = 1000;
    const cache = new FetchV2Cache({ now: () => t, badUrlTtlMs: 60_000 });
    cache.markBadUrl("https://junk.example.com/search", "search-echo page");
    expect(cache.isBadUrl("https://junk.example.com/search")).toBe(true);
    expect(cache.badUrlReason("https://junk.example.com/search")).toContain("search-echo");
    t += 61_000;
    expect(cache.isBadUrl("https://junk.example.com/search")).toBe(false);
  });

  test("no-result receipts are permanent and round-trip by primary", () => {
    const cache = new FetchV2Cache();
    expect(cache.getNoResult("054137070573")).toBeUndefined();
    cache.markNoResult("054137070573", "probed 2026-07-04: brave+quoted+unquoted empty");
    expect(cache.getNoResult("054137070573")).toContain("probed 2026-07-04");
    expect(cache.getNoResult("other")).toBeUndefined();
  });
});

describe("no-result receipts in the pipeline (credit efficiency)", () => {
  test("a receipted code spends ZERO searches and returns unknown (owner: no auto-retry)", async () => {
    const cache = new FetchV2Cache();
    cache.markNoResult("054137070573", "probed 2026-07-04");
    const search = vi.fn(async () => []);
    const r = await fetchV2("054137070573", { cache, fetchPage: vi.fn(), discovery: [{ name: "m", search }] });
    expect(search).not.toHaveBeenCalled();
    expect(r.outcome).toBe("unknown");
    expect(r.debug.rulesFired.join(" ")).toMatch(/receipt/i);
    expect(r.countBehavior.mustIncrementQuantity).toBe(true);
  });

  test("a COMPLETE empty probe writes a receipt", async () => {
    const cache = new FetchV2Cache();
    await fetchV2("054137070573", { cache, fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [{ name: "m", search: async () => [] }] });
    expect(cache.getNoResult("054137070573")).toBeTruthy();
  });

  test("a budget-truncated probe does NOT write a receipt", async () => {
    const cache = new FetchV2Cache();
    let t = 0;
    await fetchV2("054137090250", { cache, now: () => (t += 30_000), fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [{ name: "m", search: async () => [] }] }, { maxTotalMs: 25_000 });
    expect(cache.getNoResult("054137090250")).toBeFalsy();
  });

  test("junk-only findings still produce a receipt (live: dead codes always gather junk)", async () => {
    const cache = new FetchV2Cache();
    await fetchV2("4981910884903", {
      cache,
      fetchPage: async () => ({ ok: false, status: 404, html: "" }),
      discovery: [{ name: "m", search: async () => [
        { url: "https://meros.example.io/0498191", title: "Search For: 4981910884903", snippet: "4981910884903", rank: 0 },
      ] }],
    });
    expect(cache.getNoResult("4981910884903")).toBeTruthy();
  });

  test("pattern URLs are fetched FREE first; identity secured skips PAID search (free corroboration may still run)", async () => {
    const C = "028400325042";
    const search = vi.fn(async () => []);
    const paidSpy = vi.fn(async () => []);
    const html = `<html><head><title>Doritos Cool Ranch - GoUPC</title>
<script type="application/ld+json">{"@type":"Product","name":"Doritos Cool Ranch Tortilla Chips 9.25 oz","brand":{"name":"Doritos"},"gtin13":"0028400325042"}</script></head><body>UPC ${C}</body></html>`;
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, html }));
    const r = await fetchV2(C, {
      fetchPage,
      discovery: [{ name: "m", search }, { name: "firecrawl", search: paidSpy }],
      patternUrls: () => ["https://go-upc.example.com/search?q=" + C],
    });
    expect(["verified", "suggested"]).toContain(r.outcome);
    expect(r.product.name).toContain("Doritos");
    // The pattern door secures the identity at MEDIUM quality (go-upc is a "supporting" tier
    // host), so under the economic rule the FREE provider MAY still run for corroboration - only
    // the PAID escalation provider is guaranteed to be skipped (never pay to re-find what we hold).
    expect(paidSpy).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledWith("https://go-upc.example.com/search?q=" + C);
  });

  test("a MEDIUM structured hit still lets the FREE provider corroborate into verified, without ever paying (economic rule)", async () => {
    const C = "028400325042";
    const paidSpy = vi.fn(async () => []);
    const goUpcHtml = `<html><head><title>Doritos Cool Ranch - GoUPC</title>
<script type="application/ld+json">{"@type":"Product","name":"Doritos Cool Ranch Tortilla Chips 9.25 oz","brand":{"name":"Doritos"},"gtin13":"0028400325042"}</script></head><body>UPC ${C}</body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async () => ({ ok: true, status: 200, html: goUpcHtml }),
      discovery: [
        { name: "brave", search: async () => [
          { url: "https://go-upc.com/search?q=" + C, title: "Doritos Cool Ranch Tortilla Chips 9.25 oz", snippet: `UPC ${C}`, rank: 0 },
        ] },
        { name: "firecrawl", search: paidSpy },
      ],
      structured: [{
        name: "openfoodfacts",
        lookup: async () => ({
          url: "https://world.openfoodfacts.org/product/0" + C,
          name: "Doritos Cool Ranch Tortilla Chips 9.25 oz",
          brand: "Doritos",
          matchedBarcode: "0" + C,
          quality: "medium",
        }),
      }],
    });
    expect(r.outcome).toBe("verified"); // free Brave corroboration upgraded the medium structured hit
    expect(r.product.name).toContain("Doritos");
    expect(paidSpy).not.toHaveBeenCalled(); // identity already held: never pay to re-find it
  });

  test("a MEDIUM structured hit + an EMPTY free search still blocks paid escalation (identity already held)", async () => {
    const C = "028400325042";
    const search = vi.fn(async () => []);
    const paidSpy = vi.fn(async () => []);
    const r = await fetchV2(C, {
      fetchPage: vi.fn(async () => ({ ok: false, status: 404, html: "" })),
      discovery: [
        { name: "brave", search },
        { name: "firecrawl", search: paidSpy },
      ],
      structured: [{
        name: "openfoodfacts",
        lookup: async () => ({
          url: "https://world.openfoodfacts.org/product/0" + C,
          name: "Doritos Cool Ranch Tortilla Chips 9.25 oz",
          brand: "Doritos",
          matchedBarcode: "0" + C,
          quality: "medium",
        }),
      }],
    });
    expect(search).toHaveBeenCalled(); // free provider still runs for corroboration
    expect(paidSpy).not.toHaveBeenCalled(); // but paid escalation is never spent on a held identity
    expect(r.outcome).toBe("suggested"); // no corroboration found: medium alone does not verify
  });

  test("useless pattern pages fall through to normal discovery", async () => {
    const C = "028400325042";
    const search = vi.fn(async () => []);
    await fetchV2(C, {
      fetchPage: async () => ({ ok: false, status: 404, html: "" }),
      discovery: [{ name: "m", search }],
      patternUrls: () => ["https://go-upc.example.com/search?q=" + C],
    });
    expect(search).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------- discovery providers
function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe("discovery providers", () => {
  test("brave parses web.results into ranked candidates", async () => {
    const fetchImpl: MinimalFetch = vi.fn(async () => jsonResponse({ web: { results: [
      { url: "https://www.walmart.com/ip/x", title: "Doritos", description: `UPC ${CODE}` },
      { url: "https://junk.example.com/search?q=1", title: "Search", description: "" },
    ] } }));
    const p = braveProvider({ apiKey: "k", fetchImpl });
    const out = await p.search(CODE);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ url: "https://www.walmart.com/ip/x", rank: 0 });
  });

  test("brave retries once with a 'CODE barcode' query when the first query returns nothing", async () => {
    const queries: string[] = [];
    const fetchImpl: MinimalFetch = vi.fn(async (url: string) => {
      const q = decodeURIComponent(url.match(/[?&]q=([^&]+)/)?.[1] ?? "");
      queries.push(q);
      if (q.endsWith(" barcode")) return jsonResponse({ web: { results: [{ url: "https://www.walmart.com/ip/x", title: "Doritos", description: "" }] } });
      return jsonResponse({ web: { results: [] } });
    });
    const p = braveProvider({ apiKey: "k", fetchImpl });
    const out = await p.search(CODE);
    expect(queries).toEqual([CODE, `${CODE} barcode`]);
    expect(out).toHaveLength(1);
  });

  test("brave times out via AbortSignal instead of hanging", async () => {
    const fetchImpl: MinimalFetch = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    const p = braveProvider({ apiKey: "k", fetchImpl, timeoutMs: 50 });
    await expect(p.search(CODE)).resolves.toEqual([]); // timeout -> empty, never throws into the scan
  });

  test("firecrawl retries ONCE after a paced backoff when every key was rate-limited (429 burst)", async () => {
    let round = 0;
    const fetchImpl: MinimalFetch = vi.fn(async () => {
      round++;
      if (round <= 2) return jsonResponse({}, 429); // both keys rate-limited on the first pass
      return jsonResponse({ data: { web: [{ url: "https://a.example.com/p/1", title: "Atturo AZ850 315/35R21", description: "" }] } });
    });
    const p = firecrawlSearchProvider({ apiKeys: ["k1", "k2"], fetchImpl, timeoutMs: 5000, retryDelayMs: 50 });
    const out = await p.search("5060330613580");
    expect(out).toHaveLength(1);
    expect(round).toBe(3); // 2 rate-limited + 1 success on the retry pass
  });

  test("firecrawl rotates keys on 402 and parses data.web", async () => {
    const calls: string[] = [];
    const fetchImpl: MinimalFetch = vi.fn(async (_url, init) => {
      const key = init?.headers?.Authorization ?? "";
      calls.push(key);
      if (key.includes("dead")) return jsonResponse({}, 402);
      return jsonResponse({ data: { web: [{ url: "https://a.example.com/p/1", title: "A", description: "" }] } });
    });
    const p = firecrawlSearchProvider({ apiKeys: ["dead", "live"], fetchImpl });
    const out = await p.search(CODE);
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------- snippet evidence
import { snippetFindings } from "./pageEvidence/snippetEvidence";

describe("snippetFindings", () => {
  const variants = ["054137070825"];
  const cand = (url: string, title: string, snippet: string, rank = 0) => ({ url, title, snippet, rank });

  test("keeps only candidates whose title/snippet carry the exact code (digit boundaries)", () => {
    const out = snippetFindings([
      cand("https://www.ebay.com/itm/1", "Pirelli Cinturato P7 245/40R19 Tire", "UPC 054137070825 in stock"),
      cand("https://a.example.com/2", "Pirelli Cinturato P7", "part 99054137070825001"), // inside longer number
      cand("https://b.example.com/3", "Unrelated Product", "no code here"),
    ], variants, "054137070825");
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe("www.ebay.com");
    expect(out[0].name).toContain("Cinturato");
  });

  test("codes with fewer than 10 digits produce NO snippet findings (8-digit garbage collisions)", () => {
    const out = snippetFindings([
      cand("https://www.georgiamls.example.com/1", "Real Estate Agents | Georgia MLS", "listing id 10076538"),
      cand("https://shop.example.com/2", "Tesco Egg Noodles", "EAN 10076538"),
    ], ["10076538"], "10076538");
    expect(out).toHaveLength(0);
  });

  test("junk/echo titles yield a finding with empty name (evidence without identity)", () => {
    const out = snippetFindings([
      cand("https://barcode-list.com/x", "Search For: 054137070825", "054137070825 results"),
    ], variants, "054137070825");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("");
  });

  test("a title that only echoes its own host label is evidence without identity (Ashome live flip)", () => {
    // Spam aggregators title their pages with the SHOP name; "Ashome" from agvp.ashome.shop voted
    // "unrelated" in the snippet-conflict guard and demoted a correct Grabill verify (v2.3 batch 3).
    const out = snippetFindings([
      cand("https://agvp.ashome.shop/grabill-country-meats.html", "Ashome", "grabill beef chunks UPC 054137070825"),
      cand("https://shop.wilsons-warehouse.co.uk/p/1", "Wilsons Warehouse", "EAN 054137070825 in stock"),
    ], variants, "054137070825");
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe("");
    expect(out[1].name).toBe("");
  });

  test("a real product title on a shop whose domain shares a brand word keeps its identity", () => {
    const out = snippetFindings([
      cand("https://www.pirelli.com/tires/p7", "Pirelli Cinturato P7 245/40R19 Tire", "UPC 054137070825"),
    ], variants, "054137070825");
    expect(out[0].name).toContain("Cinturato");
  });

  test("on a QUOTED query the contract labels visible matches too, unless negative context vetoes (CARiD Pirelli live row)", () => {
    // Batch-5 regression: a quoted-search snippet showed the code WITHOUT a UPC/EAN word nearby and
    // was labeled=false, while the same result with the code hidden would have been labeled=true.
    // The quoted-query contract guarantees the string is in the document either way.
    const out = snippetFindings([
      cand("https://www.carid.com/pirelli-tires/p-zero.html", "PIRELLI TIRES® 3245800 - P ZERO TROFEO R 245/35ZR19XL 93(Y)", "specs 054137070825 in stock"),
      cand("https://www.realtor.example.com/mls", "Beautiful Home For Sale", "MLS # 054137070825"),
    ], variants, "054137070825", { assumeCarrying: true });
    expect(out.map((s) => s.labeled)).toEqual([true, false]);
  });

  test("snippet findings carry labeled=true only when a barcode label sits near the code", () => {
    const out = snippetFindings([
      cand("https://a.example.com/1", "Pirelli Cinturato P7 245/40R19", "UPC 054137070825 in stock"),
      cand("https://b.example.com/2", "Pirelli Cinturato P7 245/40R19 Tire", "ships fast 054137070825"),
    ], ["054137070825"], "054137070825");
    expect(out.map((s) => s.labeled)).toEqual([true, false]);
  });

  test("a quoted-door result keeps its contract label through the URL dedupe (CARiD live regression)", async () => {
    // The live bug: an escalation (quoted) result is pushed into BOTH candidate lists; the snips
    // merge built the UNASSUMED copy first and the URL dedupe kept it, discarding the labeled one.
    const TIRE = "054137070825";
    const carid = { url: "https://www.carid.com/pirelli-tires/p-zero.html", title: "PIRELLI TIRES® 3245800 - P ZERO TROFEO R 245/35ZR19XL 93(Y)", snippet: `specs ${TIRE} in stock`, rank: 0 };
    const r = await fetchV2(TIRE, {
      fetchPage: async () => ({ ok: false, status: 403, html: "" }), // page is bot-blocked; the snippet is all we have
      discovery: [
        { name: "free", search: async () => [] },
        { name: "escalation", search: async (q: string) => (q.startsWith('"') ? [carid] : []) },
      ],
    });
    expect(r.outcome).toBe("suggested");
    expect(r.product.name).toContain("TROFEO");
  });

  test("a single BARE-number snippet cannot be the sole identity (labeled can)", async () => {
    const TIRE = "054137070825";
    const mk = (snippet: string) => walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [{ name: "m", search: async () => [{ url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Tire", snippet, rank: 0 }] }],
    });
    const bare = await fetchV2(TIRE, mk(TIRE));
    expect(bare.outcome).not.toBe("suggested");
    const labeled = await fetchV2(TIRE, mk(`UPC ${TIRE}`));
    expect(labeled.outcome).toBe("suggested");
  });
});

// ---------------------------------------------------------------------------- pipeline (fetchV2)
const WALMART_HTML = `<html><head><title>Doritos Cool Ranch - Walmart.com</title>
<script type="application/ld+json">{"@type":"Product","name":"Doritos Cool Ranch Tortilla Chips 9.25 oz","brand":{"name":"Doritos"},"gtin13":"0028400325042"}</script>
</head><body>UPC ${"028400325042"}</body></html>`;
const JUNK_HTML = `<html><head><title>Search For: ${CODE}</title></head><body>results</body></html>`;

function walmartDeps(over: Partial<FetchV2Deps> = {}): FetchV2Deps {
  return {
    fetchPage: vi.fn(async (url: string) => url.includes("walmart")
      ? { ok: true, status: 200, html: WALMART_HTML }
      : { ok: true, status: 200, html: JUNK_HTML }),
    discovery: [{ name: "mock", search: async () => [
      { url: "https://www.walmart.com/ip/doritos/17248848", title: "Doritos Cool Ranch Tortilla Chips 9.25 oz", snippet: `UPC ${CODE}`, rank: 0 },
      { url: "https://barcode-list.com/barcode/EN/Search.htm?barcode=" + CODE, title: `Search For: ${CODE}`, snippet: "", rank: 1 },
    ] }],
    ...over,
  };
}

describe("fetchV2 pipeline", () => {
  test("verifies a public barcode from a JSON-LD product page", async () => {
    const r = await fetchV2(CODE, walmartDeps());
    expect(r.outcome).toBe("verified");
    expect(r.product.name).toContain("Doritos Cool Ranch");
    expect(r.evidence.codeToProductProven).toBe(true);
    expect(r.evidence.winningSourceUrl).toContain("walmart");
    expect(r.countBehavior.productAssignmentAllowed).toBe(true);
    expect(r.countBehavior.mustPersistScan).toBe(true);
    expect(r.sourcesChecked.length).toBeGreaterThan(0);
  });

  test("URL scans are unsupported: counted, grouped, no discovery calls made", async () => {
    const search = vi.fn(async () => []);
    const r = await fetchV2("https://www.example.com/products/x?utm_source=y", { fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [{ name: "m", search }] });
    expect(r.outcome).toBe("unsupported");
    expect(r.countBehavior.mustIncrementQuantity).toBe(true);
    expect(r.countBehavior.groupingKey).toBe("https://www.example.com/products/x");
    expect(search).not.toHaveBeenCalled();
  });

  test("vendor codes of 4 chars or less are too ambiguous for web identity: counted, no guess", async () => {
    // Live wrongs: '3330' matched a linemen's test set, '6619' a lighting fixture. A 4-char code
    // cannot prove product identity on the open web - hand it to the next ladder step.
    for (const short of ["3330", "6619", "P108"]) {
      const search = vi.fn(async () => [{ url: "https://x.example.com/p/1", title: "Unrelated Thing 330", snippet: "", rank: 0 }]);
      const r = await fetchV2(short, { fetchPage: async () => ({ ok: true, status: 200, html: "<html><title>Unrelated</title></html>" }), discovery: [{ name: "m", search }] });
      expect(r.outcome).toBe("unknown");
      expect(r.product.name).toBe("");
      expect(r.countBehavior.mustIncrementQuantity).toBe(true);
      expect(search).not.toHaveBeenCalled(); // do not even burn a search on it
    }
    // 5+ char vendor codes still get their shot (DCB205 was found correctly).
    const search5 = vi.fn(async () => []);
    await fetchV2("DCB205", { fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [{ name: "m", search: search5 }] });
    expect(search5).toHaveBeenCalled();
  });

  test("garbage raw text is unsupported and still counted", async () => {
    const r = await fetchV2("%$#@! garbage", { fetchPage: async () => ({ ok: false, status: 0, html: "" }), discovery: [] });
    expect(r.outcome).toBe("unsupported");
    expect(r.countBehavior.mustPersistScan).toBe(true);
  });

  test("canary: candidates exist but none carry the code => unknown, never verified", async () => {
    const r = await fetchV2("749000000015", walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>Unrelated Thing 12 oz</title></head><body>nothing relevant</body></html>" }),
    }));
    expect(r.outcome).not.toBe("verified");
    expect(["unknown", "rejected", "suggested", "needs_review"]).toContain(r.outcome);
    expect(r.countBehavior.mustIncrementQuantity).toBe(true);
  });

  test("junk-only pages => rejected outcome and bad URLs cached; cached junk is not re-fetched", async () => {
    const cache = new FetchV2Cache();
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, html: JUNK_HTML }));
    const deps = walmartDeps({ cache, fetchPage });
    const r1 = await fetchV2(CODE, deps);
    expect(r1.outcome).toBe("rejected");
    const callsAfterFirst = fetchPage.mock.calls.length;
    await fetchV2(CODE, deps);
    expect(fetchPage.mock.calls.length).toBe(callsAfterFirst); // all junk URLs remembered
  });

  test("verified result is cached: second call is a cache hit with no network", async () => {
    const cache = new FetchV2Cache();
    const deps = walmartDeps({ cache });
    const r1 = await fetchV2(CODE, deps);
    expect(r1.outcome).toBe("verified");
    const r2 = await fetchV2(CODE, deps);
    expect(r2.performance.cacheHit).toBe(true);
    expect((deps.fetchPage as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("structured source hit (Open Food Facts style) contributes as a medium finding", async () => {
    const r = await fetchV2(CODE, walmartDeps({
      discovery: [],
      structured: [{ name: "openfoodfacts", lookup: async () => ({ url: "https://world.openfoodfacts.org/product/0" + CODE, name: "Doritos Cool Ranch Tortilla Chips 9.25 oz", brand: "Doritos", matchedBarcode: "0" + CODE, quality: "medium" }) }],
    }));
    // single medium source in balanced -> suggested (not verified, not unknown)
    expect(r.outcome).toBe("suggested");
    expect(r.product.name).toContain("Doritos");
  });

  test("extracted product NAMES pass the junk firewall: site-name identity is never offered", async () => {
    // Live-run bug 2026-07-04: upcitemdb's JSON-LD carried name "upcitemdb" and it surfaced as a
    // suggested identity. A junk-shaped extracted name must be dropped, not offered.
    const html = `<html><head><title>UPC ${CODE} lookup</title>
<script type="application/ld+json">{"@type":"Product","name":"upcitemdb","gtin13":"0${CODE}"}</script>
</head><body>UPC ${CODE}</body></html>`;
    const r = await fetchV2(CODE, walmartDeps({ fetchPage: async () => ({ ok: true, status: 200, html }) }));
    expect(r.product.name).not.toMatch(/upcitemdb/i);
    expect(r.outcome).not.toBe("verified");
  });

  test("'Nutrition Facts' header extracted as a name is dropped as identity", async () => {
    const html = `<html><head><title>Products</title></head><body><h1>Nutrition Facts</h1>
<table><tr><th>UPC</th><td>${CODE}</td></tr></table></body></html>`;
    const r = await fetchV2(CODE, walmartDeps({ fetchPage: async () => ({ ok: true, status: 200, html }) }));
    expect(r.product.name.toLowerCase()).not.toBe("nutrition facts");
    expect(r.outcome).not.toBe("verified");
  });

  test("store-nav titles are never identities: 'Product Details' and 'My Store' shapes (live bugs)", async () => {
    const makita = `<html><head><title>Makita</title><meta property="og:title" content="Makita USA - Product Details -BL1850B"/></head><body>BL1850B battery page</body></html>`;
    const r1 = await fetchV2("BL1850B", walmartDeps({ fetchPage: async () => ({ ok: true, status: 200, html: makita }) }));
    expect(r1.product.name).not.toMatch(/product details/i);
    const myStore = `<html><head><title>Shop</title><meta property="og:title" content="My Store P108"/></head><body>P108 replacement</body></html>`;
    const r2 = await fetchV2("P108", walmartDeps({ fetchPage: async () => ({ ok: true, status: 200, html: myStore }) }));
    expect(r2.product.name).not.toMatch(/my store/i);
  });

  test("JSON-LD whose name IS the code with a default shop brand offers no identity (P108 bug)", async () => {
    const html = `<html><head><title>P108</title>
<script type="application/ld+json">{"@type":"Product","name":"P108","brand":{"@type":"Brand","name":"My Store"},"description":"Inner Adaptor Washer"}</script>
</head><body>P108 washer</body></html>`;
    const r = await fetchV2("P108", walmartDeps({ fetchPage: async () => ({ ok: true, status: 200, html }) }));
    expect(r.product.name).toBe("");
    expect(r.product.brand).not.toMatch(/my store/i);
    expect(["unknown", "rejected", "needs_review"]).toContain(r.outcome);
  });

  test("structured source hits with junk-shaped names are dropped too", async () => {
    const r = await fetchV2(CODE, walmartDeps({
      discovery: [],
      structured: [{ name: "off", lookup: async () => ({ url: "https://world.openfoodfacts.org/product/0" + CODE, name: "Unknown", brand: "", matchedBarcode: "0" + CODE, quality: "medium" }) }],
    }));
    expect(r.outcome).toBe("unknown");
    expect(r.product.name).toBe("");
  });

  test("SNIPPET CONSENSUS verifies: 3+ distinct hosts carry the code and agree, pages show nothing", async () => {
    const TIRE = "054137070825";
    const deps = walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>Item page</title></head><body>JS shell, no code</body></html>" }),
      discovery: [{ name: "m", search: async () => [
        { url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Run Flat Tire", snippet: `UPC ${TIRE}`, rank: 0 },
        { url: "https://www.tireshop.example.com/p/2", title: "Pirelli Cinturato P7 245/40R19", snippet: `barcode ${TIRE}`, rank: 1 },
        { url: "https://www.parts.example.net/i/3", title: "Cinturato P7 245/40R19 Pirelli", snippet: `${TIRE}`, rank: 2 },
      ] }],
    });
    const r = await fetchV2(TIRE, deps);
    expect(r.outcome).toBe("verified");
    expect(r.evidence.codeLocation).toBe("search_snippets");
    expect(r.evidence.finalConfidence).toBeCloseTo(0.85, 2);
    expect(r.product.name).toMatch(/cinturato/i);
  });

  test("snippet consensus with only 2 agreeing hosts => suggested, not verified", async () => {
    const TIRE = "054137070825";
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>nothing</body></html>" }),
      discovery: [{ name: "m", search: async () => [
        { url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Tire", snippet: `UPC ${TIRE}`, rank: 0 },
        { url: "https://www.shop.example.com/p/2", title: "Pirelli Cinturato P7 245/40R19", snippet: TIRE, rank: 1 },
      ] }],
    }));
    expect(r.outcome).toBe("suggested");
  });

  test("3 hosts on the SAME domain do not fake consensus", async () => {
    const TIRE = "054137070825";
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [{ name: "m", search: async () => [0, 1, 2].map((i) => (
        { url: `https://www.ebay.com/itm/${i}`, title: "Pirelli Cinturato P7 245/40R19 Tire", snippet: TIRE, rank: i }
      )) }],
    }));
    expect(r.outcome).not.toBe("verified");
  });

  test("a code-carrying snippet naming an UNRELATED product blocks snippet verification => needs_review", async () => {
    const TIRE = "054137070825";
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [{ name: "m", search: async () => [
        { url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Tire", snippet: TIRE, rank: 0 },
        { url: "https://www.shop.example.com/p/2", title: "Pirelli Cinturato P7 245/40R19", snippet: TIRE, rank: 1 },
        { url: "https://www.other.example.net/p/3", title: "Jo Malone English Pear Cologne 100ml", snippet: TIRE, rank: 2 },
      ] }],
    }));
    expect(r.outcome).toBe("needs_review");
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  test("price-comparison/category/download titles are never identities (200-run live wrongs)", async () => {
    const TIRE = "054137070825";
    const junkTitles = [
      "255/35 R18 PKW Sommerreifen — Jetzt günstig kaufen",
      "275 45 R19 Other off-road tires – Compare prices in United States",
      "[PDF] 2013 Mastercraft Tire Product Manual - Free Download PDF",
      "Salīdziniet cenas Riepas 15.3 colla | Visos-riepas.lv",
      "Llantas Toyo Open Country H/T – compare precios y compre barato", // Spanish (loop-2 live wrong)
      "Model Type SW Speed Rating M/W Size Item # UPC Code Sell AFFINITY AS", // pricing-sheet header (forensic)
      "UPC Lookup for 0929712##### - Meros.io", // lookup-site echo (forensic)
      "225/65 R16 pneus auto achetez en ligne", // French category page (loop-10 live)
      "255/35 R18 große PKW Sommerreifen zum Hammerpreis bei uns im Shop", // German variant 2 (loop-10 live)
      "Euro to US Dollar, EUR to USD conversion rates", // currency-widget headline (canary breach 749000000022)
    ];
    for (const title of junkTitles) {
      const r = await fetchV2(TIRE, walmartDeps({
        fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
        discovery: [{ name: "m", search: async () => [{ url: "https://shop.example.com/c/1", title, snippet: TIRE, rank: 0 }] }],
      }));
      expect(r.product.name, title).toBe("");
      expect(r.outcome).not.toBe("suggested");
    }
  });

  test("canary discipline: plausible titles WITHOUT the code in snippets never verify via snippets", async () => {
    const r = await fetchV2("749000000015", walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [{ name: "m", search: async () => [
        { url: "https://www.ebay.com/itm/1", title: "Magic Boss Water Repellent 12 Pack", snippet: "great product", rank: 0 },
        { url: "https://www.a.example.com/2", title: "Genuine Joe Disinfectant Wipes", snippet: "", rank: 1 },
        { url: "https://www.b.example.net/3", title: "Pepcid Original Strength 30ct", snippet: "", rank: 2 },
      ] }],
    }));
    expect(r.outcome).not.toBe("verified");
    expect(r.outcome).not.toBe("suggested");
  });

  test("CANARY: an echo-table page from the pattern door can never produce an identity", async () => {
    const html = `<html><head><title>Currency</title></head><body><h1>Euro to US Dollar, EUR to USD</h1><table><tr><th>UPC</th><td>749000000022</td></tr></table></body></html>`;
    const r = await fetchV2("749000000022", {
      fetchPage: async () => ({ ok: true, status: 200, html }),
      discovery: [{ name: "m", search: async () => [] }],
      patternUrls: () => ["https://go-upc.example.com/search?q=749000000022"],
    });
    expect(r.outcome).not.toBe("suggested");
    expect(r.outcome).not.toBe("verified");
    expect(r.product.name).toBe("");
  });

  test("escalates to the SECOND provider with a QUOTED query when no candidate carries the code", async () => {
    const TIRE = "054137070825";
    const fcQueries: string[] = [];
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>Item page</title></head><body>nothing</body></html>" }),
      discovery: [
        { name: "brave", search: async () => [{ url: "https://blog.example.com/1", title: "Some tire article", snippet: "no code", rank: 0 }] },
        { name: "firecrawl", search: async (q: string) => { fcQueries.push(q); return [
          { url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Tire", snippet: `UPC ${TIRE}`, rank: 0 },
          { url: "https://www.shop.example.com/p/2", title: "Pirelli Cinturato P7 245/40R19", snippet: TIRE, rank: 1 },
          { url: "https://www.parts.example.net/i/3", title: "Cinturato P7 245/40R19 by Pirelli", snippet: TIRE, rank: 2 },
        ]; } },
      ],
    }));
    expect(fcQueries).toEqual([`"${TIRE}"`]); // the owner's comillas move
    expect(r.outcome).toBe("verified"); // 3 agreeing independent code-carrying snippets
  });

  test("no escalation when the first provider already found code-carrying candidates", async () => {
    const TIRE = "054137070825";
    const fc = vi.fn(async () => []);
    await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>Item</title></head><body>x</body></html>" }),
      discovery: [
        { name: "brave", search: async () => [{ url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19", snippet: TIRE, rank: 0 }] },
        { name: "firecrawl", search: fc },
      ],
    }));
    expect(fc).not.toHaveBeenCalled();
  });

  test("QUOTED escalation results count as code-carrying even when snippets hide the code (exact-match contract; canary-proven live)", async () => {
    const TIRE = "054137070825";
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>Item</title></head><body>JS shell</body></html>" }),
      discovery: [
        { name: "brave", search: async () => [{ url: "https://blog.example.com/1", title: "Tire buying guide", snippet: "no code", rank: 0 }] },
        { name: "firecrawl", search: async () => [
          { url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Run Flat Tire", snippet: "in stock", rank: 0 },
          { url: "https://www.tires.example.com/p/2", title: "Pirelli Cinturato P7 245/40R19", snippet: "", rank: 1 },
          { url: "https://www.parts.example.net/i/3", title: "Cinturato P7 245/40R19 by Pirelli", snippet: "", rank: 2 },
        ] },
      ],
    }));
    expect(r.outcome).toBe("verified"); // 3 agreeing hosts from the exact-match query
    expect(r.evidence.codeLocation).toBe("search_snippets");
  });

  test("the quoted escalation ALWAYS gets one shot even when earlier steps ate the time budget (Atturo live bug)", async () => {
    const TIRE = "5060330613580";
    let t = 0;
    const fc = vi.fn(async () => [{ url: "https://www.offroadrimfinancing.com/product/atturo", title: "Atturo AZ850 Performance 315/35/21 Tire - Off-Road Rim", snippet: "", rank: 0 }]);
    const r = await fetchV2(TIRE, {
      now: () => (t += 20_000), // every clock read jumps 20s: budget gone after the first provider
      fetchPage: async () => ({ ok: false, status: 0, html: "" }),
      discovery: [
        { name: "brave", search: async () => [] },
        { name: "firecrawl", search: fc },
      ],
    }, { maxTotalMs: 25_000 });
    expect(fc).toHaveBeenCalled();
    expect(r.outcome).toBe("suggested");
    expect(r.product.name).toMatch(/atturo/i);
  });

  test("brave paces its internal retry so the free tier's 1 req/s limit is respected", async () => {
    const times: number[] = [];
    const fetchImpl: MinimalFetch = vi.fn(async () => { times.push(Date.now()); return jsonResponse({ web: { results: [] } }); });
    const p = braveProvider({ apiKey: "k", fetchImpl, timeoutMs: 5000, retryDelayMs: 120 });
    await p.search("054137070825");
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
  });

  test("when the QUOTED escalation finds nothing, one UNQUOTED escalation runs (visible-code only)", async () => {
    const TIRE = "4981910884903";
    const queries: string[] = [];
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [
        { name: "brave", search: async () => [{ url: "https://toys.example.com/1", title: "Anime Figurine", snippet: "no code", rank: 0 }] },
        { name: "firecrawl", search: async (q: string) => {
          queries.push(q);
          if (q.startsWith('"')) return []; // quoted finds nothing
          return [
            { url: "https://www.tireshop.example.com/p/1", title: "Toyo Eclipse 185/65R14 Tire", snippet: `EAN ${TIRE}`, rank: 0 },
            { url: "https://www.parts.example.net/p/2", title: "Toyo Eclipse 185/65R14", snippet: TIRE, rank: 1 },
          ];
        } },
      ],
    }));
    expect(queries).toEqual([`"${TIRE}"`, TIRE]);
    expect(r.outcome).toBe("suggested"); // 2 agreeing visible-code hosts
    expect(r.product.name).toMatch(/eclipse/i);
  });

  test("a BOT-BLOCKED page does not kill its own snippet evidence (Goodride forensic root cause)", async () => {
    const TIRE = "690677301168";
    const cache = new FetchV2Cache();
    const r = await fetchV2(TIRE, {
      cache,
      fetchPage: async () => ({ ok: false, status: 403, html: "" }), // marketplace blocks every fetch
      discovery: [{ name: "brave", search: async () => [
        { url: "https://www.ebay.com/itm/303464639768", title: "Tire Goodride ST100 Steel Belted ST 225/75R15 Load E 10 Ply Trailer | eBay", snippet: `UPC ${TIRE}`, rank: 0 },
        { url: "https://www.ebay.com.au/itm/305182379672", title: "Tire ST 225/75R15 117/112M Load E 10 Ply Goodride ST100", snippet: TIRE, rank: 1 },
        { url: "https://laughspark.example.com/product/goodride-st100", title: "Goodride ST100 ST225/75R15 117/112M E Trailer Tire", snippet: TIRE, rank: 2 },
      ] }],
    });
    expect(r.outcome).toBe("verified"); // 3 agreeing code-carrying hosts; blocked pages are not junk
    expect(r.product.name).toMatch(/goodride/i);
  });

  test("an INVISIBLE code arriving only on the quoted-RETRY search still rescues (contract label)", async () => {
    // Closes the re-review coverage gap: assumeCarrying labeling must hold for the freshAgain
    // retry branch, not only the initial escalation hit.
    const TIRE = "051342118137";
    const queries: string[] = [];
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [
        { name: "brave", search: async () => [] },
        { name: "firecrawl", search: async (q: string) => {
          queries.push(q);
          if (queries.length <= 2) return [];
          // Retry result: code NOT visible anywhere - the exact-match contract is the label.
          return [{ url: "https://wheelmax.example.com/p/1", title: "275/35R20 Continental Contisportcontact 3 Run Flat", snippet: "in stock, ships fast", rank: 0 }];
        } },
      ],
    }));
    expect(queries).toEqual([`"${TIRE}"`, TIRE, `"${TIRE}"`]);
    expect(r.outcome).toBe("suggested");
    expect(r.product.name).toMatch(/contisportcontact/i);
  });

  test("quoted escalation retries ONCE on empty (search-backend variance; 5-search cap total)", async () => {
    const TIRE = "051342118137";
    const queries: string[] = [];
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [
        { name: "brave", search: async () => [] },
        { name: "firecrawl", search: async (q: string) => {
          queries.push(q);
          // 1st quoted: empty (variance). unquoted: garbage. 2nd quoted: the real result.
          if (queries.length <= 2) return [];
          return [{ url: "https://wheelmax.example.com/p/1", title: "275/35R20 Continental Contisportcontact 3 Run Flat", snippet: TIRE, rank: 0 }];
        } },
      ],
    }));
    expect(queries).toEqual([`"${TIRE}"`, TIRE, `"${TIRE}"`]);
    // The quoted contract labels this result whether the snippet shows the code or hides it
    // (CARiD live regression: visible-but-unlabeled on a quoted result was punished relative to
    // the invisible twin fixture above). Negative context (MLS/listing/item#) still vetoes; a
    // bare number on an UNQUOTED result still cannot suggest (locked separately below).
    expect(r.outcome).toBe("suggested");
    expect(r.product.name).toMatch(/contisportcontact/i);
  });

  test("a single visible bare-number snippet still cannot be the sole identity", async () => {
    const TIRE = "054137070825";
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: true, status: 200, html: "<html><head><title>x</title></head><body>n</body></html>" }),
      discovery: [{ name: "m", search: async () => [{ url: "https://www.ebay.com/itm/1", title: "Pirelli Cinturato P7 245/40R19 Tire", snippet: TIRE, rank: 0 }] }],
    }));
    expect(r.outcome).not.toBe("suggested");
  });

  test("a NAMELESS code-carrying junk candidate must not stop the escalation (Minerva live bug)", async () => {
    const TIRE = "5420068601394";
    const fc = vi.fn(async () => [
      { url: "https://www.auto-doc.fr/p/1", title: "Pneu Minerva TRANSPORT RF09 C T 225/65 R16", snippet: TIRE, rank: 0 },
      { url: "https://www.ultrapneus.fr/p/2", title: "Pneu MINERVA Transporter RF09 225/65 R16", snippet: TIRE, rank: 1 },
      { url: "https://www.pneumatici.it/p/3", title: "Minerva Transporter - 225/65 R16 112R", snippet: TIRE, rank: 2 },
    ]);
    const r = await fetchV2(TIRE, walmartDeps({
      fetchPage: async () => ({ ok: false, status: 403, html: "" }),
      discovery: [
        // Brave returns a French category page: code visible, but the name is firewall junk.
        { name: "brave", search: async () => [{ url: "https://pneus.example.fr/225-65-r16", title: "225/65 R16 pneus auto achetez en ligne", snippet: TIRE, rank: 0 }] },
        { name: "firecrawl", search: fc },
      ],
    }));
    expect(fc).toHaveBeenCalled();
    expect(r.outcome).toBe("verified"); // 3 agreeing named hosts
    expect(r.product.name).toMatch(/minerva/i);
  });

  test("respects maxTotalMs budget and reports earlyStopped", async () => {
    let t = 0;
    const deps = walmartDeps({
      now: () => (t += 5000), // every clock read jumps 5s -> budget immediately exceeded
      fetchPage: vi.fn(async () => ({ ok: true, status: 200, html: WALMART_HTML })),
    });
    const r = await fetchV2(CODE, deps, { maxTotalMs: 8000 });
    expect(r.performance.earlyStopped).toBe(true);
  });

  test("vetted DB host + labeled structured code + FREE agreement => VERIFIED (owner one-good-source rule)", async () => {
    const C = "051342118137";
    const html = `<html><head><title>Continental ContiSportContact 3 275/35R20 - Go-UPC</title></head><body>
<h1>Continental ContiSportContact 3 275/35R20</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("go-upc") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        { url: "https://wheelmax.example.com/p/1", title: "275/35R20 Continental Contisportcontact 3 Run Flat", snippet: "in stock", rank: 0 },
      ] }],
      patternUrls: () => ["https://go-upc.example.com/product/" + C], // NON-search URL: no echo
    });
    expect(r.outcome).toBe("verified");
    expect(r.evidence.finalConfidence).toBeCloseTo(0.8, 2);
  });

  test("SELF-agreement never satisfies the fence: brave returning the vetted page itself does not verify", async () => {
    const C = "092971135485";
    const html = `<html><head><title>Westlake SU318 275/65R17 - Go-UPC</title></head><body>
<h1>Westlake SU318 All Season 275/65R17</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("go-upc") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        // brave independently surfaces the SAME vetted page - its title must not fence itself
        { url: "https://go-upc.example.com/product/" + C, title: "Westlake SU318 All Season 275/65R17 - Go-UPC", snippet: "", rank: 0 },
      ] }],
      patternUrls: () => ["https://go-upc.example.com/product/" + C],
    });
    expect(r.outcome).toBe("suggested");
  });

  test("vetted host WITHOUT free agreement stays suggested (recycled-code fence, pre-tested live)", async () => {
    const C = "092971135485";
    const html = `<html><head><title>Westlake SU318 275/65R17 - Go-UPC</title></head><body>
<h1>Westlake SU318 All Season 275/65R17</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("go-upc") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        { url: "https://random.example.com/1", title: "Standard Electrical System Parts Ignition Sensors", snippet: "", rank: 0 },
      ] }],
      patternUrls: () => ["https://go-upc.example.com/product/" + C],
    });
    expect(r.outcome).toBe("suggested");
  });

  test("pattern-door identity + one agreeing labeled snippet = verified pair", async () => {
    const C = "028400325042";
    const html = `<html><head><title>Doritos Cool Ranch 9.25oz - Go-UPC</title></head><body><h1>Doritos Cool Ranch Tortilla Chips 9.25 oz</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("go-upc") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        { url: "https://www.grocer.example.com/p/1", title: "Doritos Cool Ranch Tortilla Chips 9.25 oz", snippet: `UPC ${C}`, rank: 0 },
      ] }],
      patternUrls: () => ["https://go-upc.example.com/product/" + C],
    });
    expect(r.outcome).toBe("verified");
  });

  test("NON-vetted pattern-door identity + one agreeing labeled snippet = verified via corroboration (not the vetted-host fence)", async () => {
    const C = "028400325042";
    const html = `<html><head><title>Doritos Cool Ranch 9.25oz - Buycott</title></head><body><h1>Doritos Cool Ranch Tortilla Chips 9.25 oz</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("buycott") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        { url: "https://www.grocer.example.com/p/1", title: "Doritos Cool Ranch Tortilla Chips 9.25 oz", snippet: `UPC ${C}`, rank: 0 },
      ] }],
      patternUrls: () => ["https://buycott.example.com/upc/" + C],
    });
    expect(r.outcome).toBe("verified");
  });

  test("a third DISAGREEING labeled snippet blocks the door+snippet verified pair (recycled-code guard order)", async () => {
    const C = "028400325042";
    const html = `<html><head><title>Doritos Cool Ranch 9.25oz</title></head><body><h1>Doritos Cool Ranch Tortilla Chips 9.25 oz</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("buycott") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        { url: "https://www.grocer.example.com/p/1", title: "Doritos Cool Ranch Tortilla Chips 9.25 oz", snippet: `UPC ${C}`, rank: 0 },
        { url: "https://www.other.example.net/p/2", title: "Charmin Ultra Soft Toilet Paper Mega Rolls", snippet: `UPC ${C}`, rank: 1 },
      ] }],
      patternUrls: () => ["https://buycott.example.com/product/" + C],
    });
    expect(r.outcome).toBe("needs_review");
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  test("www vs bare domain is the SAME host: no false corroboration pair", async () => {
    const C = "028400325042";
    const html = `<html><head><title>Doritos Cool Ranch 9.25oz</title></head><body><h1>Doritos Cool Ranch Tortilla Chips 9.25 oz</h1><table><tr><th>UPC</th><td>${C}</td></tr></table></body></html>`;
    const r = await fetchV2(C, {
      fetchPage: async (u: string) => u.includes("buycott") ? { ok: true, status: 200, html } : { ok: false, status: 403, html: "" },
      discovery: [{ name: "brave", search: async () => [
        // Same real site as the door page, just with www - must NOT count as an independent host.
        { url: "https://www.buycott.example.com/product/" + C, title: "Doritos Cool Ranch Tortilla Chips 9.25 oz", snippet: `UPC ${C}`, rank: 0 },
      ] }],
      patternUrls: () => ["https://buycott.example.com/product/" + C],
    });
    expect(r.outcome).not.toBe("verified");
  });

  // ---------------------------------------------------------- AM-7 / Task 12: ASIN + keyless door
  test("AM-7: the FREE pattern-URL door fires for a public barcode with ZERO discovery providers (keyless reachability)", async () => {
    // Before AM-7 the door lived inside `if (needsDiscovery && deps.discovery.length > 0)` - an
    // empty discovery array (no keys configured) skipped the door entirely, even though it is free
    // and needs no discovery provider at all. This proves the door is now reachable keyless.
    const C = "028400325042";
    const html = `<html><head><title>Doritos Cool Ranch - GoUPC</title>
<script type="application/ld+json">{"@type":"Product","name":"Doritos Cool Ranch Tortilla Chips 9.25 oz","brand":{"name":"Doritos"},"gtin13":"0028400325042"}</script></head><body>UPC ${C}</body></html>`;
    const fetchPage = vi.fn(async () => ({ ok: true, status: 200, html }));
    const r = await fetchV2(C, {
      fetchPage,
      discovery: [], // no discovery providers configured at all
      patternUrls: () => ["https://go-upc.example.com/search?q=" + C],
    });
    expect(fetchPage).toHaveBeenCalledWith("https://go-upc.example.com/search?q=" + C);
    expect(["verified", "suggested"]).toContain(r.outcome);
    expect(r.product.name).toContain("Doritos");
  });

  test("Task 12/ASIN door: an asin identifier fetches its pattern URL and yields a suggestion-grade identity, never verified", async () => {
    const ASIN = "B08XYZ1234";
    // A realistic Amazon /dp/ page: JSON-LD Product carrying the ASIN in sku/mpn (Amazon dp pages
    // commonly emit structured data this way) plus the literal "ASIN B08XYZ1234" detail-table text.
    const html = `<html><head><title>Anker PowerCore 10000 Portable Charger</title>
<script type="application/ld+json">{"@type":"Product","name":"Anker PowerCore 10000 Portable Charger","brand":{"name":"Anker"},"sku":"${ASIN}"}</script></head>
<body><table><tr><th>ASIN</th><td>${ASIN}</td></tr></table></body></html>`;
    const fetchPage = vi.fn(async (url: string) =>
      url === `https://www.amazon.com/dp/${ASIN}` ? { ok: true, status: 200, html } : { ok: false, status: 404, html: "" },
    );
    const r = await fetchV2(ASIN, {
      fetchPage,
      discovery: [],
      patternUrls: () => [`https://www.amazon.com/dp/${ASIN}`],
    });
    expect(fetchPage).toHaveBeenCalledWith(`https://www.amazon.com/dp/${ASIN}`);
    expect(r.sourcesChecked).toContain(`https://www.amazon.com/dp/${ASIN}`);
    expect(r.identifier.type).toBe("asin");
    expect(r.product.name).toContain("Anker");
    // Suggestion-grade by construction: decideOutcome never verifies a non-public-barcode identifier.
    expect(r.outcome).not.toBe("verified");
    expect(r.outcome).toBe("suggested");
    expect(r.countBehavior.productAssignmentAllowed).toBe(false);
  });

  test("Task 12/ASIN door: a bot-walled dp page (503 Robot Check) degrades to no identity, no crash", async () => {
    const ASIN = "B08XYZ1234";
    const robotHtml = `<html><head><title>Robot Check</title></head><body>Sorry, we just need to make sure you're not a robot.</body></html>`;
    const fetchPage = vi.fn(async () => ({ ok: false, status: 503, html: robotHtml }));
    const r = await fetchV2(ASIN, {
      fetchPage,
      discovery: [],
      patternUrls: () => [`https://www.amazon.com/dp/${ASIN}`],
    });
    expect(fetchPage).toHaveBeenCalledWith(`https://www.amazon.com/dp/${ASIN}`);
    expect(r.product.name).toBe("");
    expect(r.outcome).not.toBe("verified");
    // Falls through exactly like today's vendor-label dead end: unknown/needs_review, never a crash.
    expect(["unknown", "needs_review", "suggested"]).toContain(r.outcome);
  });
});
