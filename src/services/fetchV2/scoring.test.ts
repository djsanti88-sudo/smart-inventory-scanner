// Characterization tests for scoring.ts: source quality scoring + the decideOutcome ladder.
// These PIN current behavior exactly as written. Do not "fix" anything that looks odd here -
// note it in the task report instead. Complements (does not duplicate) the scoring/decideOutcome
// coverage already in engine.test.ts: this file adds hostOf(), hostname-normalization edge cases,
// the empty-evidence path, the vetted-DB-host free-agreement-fence verify tier, the 3-host snippet
// consensus tier, and the snippet-vs-non-snippet conflict-scan ordering.
import { describe, expect, test } from "vitest";
import { scoreSource, decideOutcome, hostOf, TRUSTED_DB_HOSTS, type SourceFinding } from "./scoring";
import { classifyIdentifier } from "./classify";
import type { AssociationProof } from "./pageEvidence/association";
import type { ExtractedProduct } from "./pageEvidence/extract";

const CODE = "028400325042";
const pubId = classifyIdentifier(CODE);

const strongAssoc: AssociationProof = { level: "strong", matchedVariant: CODE, matchedField: "json_ld.gtin", product: null };
const weakAssoc: AssociationProof = { level: "weak", matchedVariant: CODE, matchedField: "page_text", product: null };
const noAssoc: AssociationProof = { level: "none", matchedVariant: "", matchedField: "", product: null };

const doritos: ExtractedProduct = {
  source: "json_ld",
  name: "Doritos Cool Ranch Tortilla Chips 9.25 oz",
  brand: "Doritos",
  gtins: ["0028400325042"],
  sku: "",
  description: "",
  imageUrl: "",
};

function finding(over: Partial<SourceFinding>): SourceFinding {
  return {
    url: "https://www.walmart.com/ip/x",
    association: strongAssoc,
    product: doritos,
    junkRejected: false,
    junkReasons: [],
    quality: "strong",
    score: 85,
    ...over,
  };
}

// ---------------------------------------------------------------------------- hostOf
describe("hostOf", () => {
  test("lowercases and strips a leading www.", () => {
    expect(hostOf("https://WWW.Go-UPC.com/search?q=1")).toBe("go-upc.com");
  });

  test("leaves a non-www host untouched (lowercased)", () => {
    expect(hostOf("https://Go-UPC.com/x")).toBe("go-upc.com");
  });

  test("an unparseable URL falls back to returning the raw input", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

// ---------------------------------------------------------------------------- scoreSource
describe("scoreSource: quality tiers and the score numbers behind them", () => {
  test("junk-rejected always wins over any association level (score 0, quality rejected)", () => {
    const s = scoreSource("https://gs1.org/x", strongAssoc, true);
    expect(s).toEqual({ quality: "rejected", score: 0 });
  });

  test("association level 'none' short-circuits to weak/10 regardless of host trust", () => {
    // Even an authoritative host (gs1.org) is capped to weak when the code was never tied to it.
    const s = scoreSource("https://gs1.org/x", noAssoc, false);
    expect(s).toEqual({ quality: "weak", score: 10 });
  });

  test("authoritative tier + strong association scores 95 (the only 95 path)", () => {
    const s = scoreSource("https://gs1.org/x", strongAssoc, false);
    expect(s).toEqual({ quality: "strong", score: 95 });
  });

  test("strong_commercial tier + strong association scores 85, not 95", () => {
    const s = scoreSource("https://www.walmart.com/ip/x", strongAssoc, false);
    expect(s).toEqual({ quality: "strong", score: 85 });
  });

  test("supporting tier (barcode DB) + strong association caps at medium/55, never strong", () => {
    const s = scoreSource("https://go-upc.com/search?q=" + CODE, strongAssoc, false);
    expect(s).toEqual({ quality: "medium", score: 55 });
  });

  test("an unrecognized host defaults to supporting tier (never weak), so strong assoc caps at medium/55", () => {
    // classifySource's policy comment says unknown hosts are Tier 3 "supporting" (never
    // authoritative), NOT weak - only a junk-path/query URL forces weak. Pinning that here since
    // it is easy to assume an unrecognized host is automatically distrusted.
    const s = scoreSource("https://random-blog.example.net/post", strongAssoc, false);
    expect(s).toEqual({ quality: "medium", score: 55 });
  });

  test("a junk-path URL on an unrecognized host IS weak tier, even with a strong association", () => {
    const s = scoreSource("https://random-blog.example.net/search?q=x", strongAssoc, false);
    expect(s).toEqual({ quality: "weak", score: 30 });
  });

  test("a WEAK association caps an otherwise-authoritative host down to weak/30", () => {
    // association.level === "weak" forces quality = "weak" regardless of source tier (line 35).
    const s = scoreSource("https://gs1.org/x", weakAssoc, false);
    expect(s).toEqual({ quality: "weak", score: 30 });
  });
});

// ---------------------------------------------------------------------------- decideOutcome: empty/edge paths
describe("decideOutcome: structural edge cases", () => {
  test("empty findings array => unknown, 0 confidence, null winner, rulesFired names it", () => {
    const d = decideOutcome(pubId, [], "balanced");
    expect(d).toEqual({ outcome: "unknown", confidence: 0, winner: null, conflicts: [], rulesFired: ["no findings"] });
  });

  test("every finding junk-rejected => rejected, conflicts carries the junk reasons", () => {
    const d = decideOutcome(
      pubId,
      [finding({ junkRejected: true, quality: "rejected", score: 0, association: noAssoc, product: null, junkReasons: ["search page"] })],
      "balanced",
    );
    expect(d.outcome).toBe("rejected");
    expect(d.confidence).toBe(0);
    expect(d.winner).toBeNull();
    expect(d.conflicts).toEqual(["search page"]);
  });

  test("findings with product but empty/blank name are never counted as 'identified'", () => {
    const blank = { ...doritos, name: "   " };
    const d = decideOutcome(pubId, [finding({ product: blank, association: weakAssoc, quality: "weak", score: 30 })], "balanced");
    expect(d.outcome).toBe("unknown");
  });

  test("check-digit-invalid public barcode never verifies even with a strong single source", () => {
    // classifyIdentifier on a real UPC won't produce checkDigitValid:false, so build the
    // identifier object directly to pin decideOutcome's own branch (line 179).
    const badCheckDigit = { ...pubId, checkDigitValid: false as const };
    const d = decideOutcome(badCheckDigit, [finding({})], "balanced");
    expect(d.outcome).not.toBe("verified");
    expect(d.rulesFired).toContain("check digit invalid: verification not allowed");
  });

  test("non-public identifier records its own rule string", () => {
    const asin = classifyIdentifier("B09B8V1LZ3");
    const d = decideOutcome(asin, [finding({})], "balanced");
    expect(d.rulesFired).toContain("non-public identifier: verification not allowed");
  });
});

// ---------------------------------------------------------------------------- vetted DB host "one good source"
describe("decideOutcome: vetted-DB-host free-agreement fence (owner 'one good source' rule)", () => {
  const vettedFinding = (over: Partial<SourceFinding> = {}) =>
    finding({
      url: "https://go-upc.com/" + CODE, // no ?q= so it is not a detail_table_echo/query-echo URL
      quality: "medium",
      score: 55,
      freeAgree: true,
      ...over,
    });

  test("vetted host + exact labeled code + free-agreement fence verifies ALONE at confidence 0.8", () => {
    const d = decideOutcome(pubId, [vettedFinding()], "balanced");
    expect(d.outcome).toBe("verified");
    expect(d.confidence).toBe(0.8);
    expect(d.rulesFired).toContain("vetted DB host with exact labeled code + free-agreement fence");
  });

  test("without the free-agreement fence (freeAgree false), the same vetted host does NOT verify alone", () => {
    const d = decideOutcome(pubId, [vettedFinding({ freeAgree: false })], "balanced");
    expect(d.outcome).not.toBe("verified");
  });

  test("a detail_table_echo association on a vetted host never qualifies, fence or not", () => {
    const echoAssoc: AssociationProof = { level: "strong", matchedVariant: CODE, matchedField: "detail_table_echo", product: null };
    const d = decideOutcome(pubId, [vettedFinding({ association: echoAssoc, freeAgree: true })], "balanced");
    expect(d.outcome).not.toBe("verified");
  });

  test("TRUSTED_DB_HOSTS matches exactly the owner-approved narrow list", () => {
    for (const host of ["go-upc.com", "upcitemdb.com", "eandata.com", "barcodelookup.com", "barcodespider.com"]) {
      expect(TRUSTED_DB_HOSTS.test(host)).toBe(true);
    }
    expect(TRUSTED_DB_HOSTS.test("random-blog.example.net")).toBe(false);
  });
});

// ---------------------------------------------------------------------------- snippet consensus (3-host) tier
describe("decideOutcome: search-snippet consensus tier (3+ distinct hosts agree)", () => {
  const snippetFinding = (url: string, product: ExtractedProduct, labeled = false): SourceFinding => ({
    url,
    association: { level: "weak", matchedVariant: CODE, matchedField: "search_snippets", product },
    product,
    junkRejected: false,
    junkReasons: [],
    quality: "weak",
    score: 30,
    labeled,
  });

  test("3 distinct hosts, all agreeing snippets => verified at 0.85, winner = richest name", () => {
    const short = { ...doritos, name: "Doritos" };
    const rich = { ...doritos, name: "Doritos Cool Ranch Tortilla Chips Party Size 9.25 oz Bag" };
    const d = decideOutcome(
      pubId,
      [
        snippetFinding("https://a.example.com/1", short),
        snippetFinding("https://b.example.com/2", doritos),
        snippetFinding("https://c.example.com/3", rich),
      ],
      "balanced",
    );
    expect(d.outcome).toBe("verified");
    expect(d.confidence).toBe(0.85);
    expect(d.winner?.product?.name).toBe(rich.name);
  });

  test("only 2 distinct agreeing hosts records a suggestion-grade note but does NOT verify via this tier", () => {
    const d = decideOutcome(
      pubId,
      [snippetFinding("https://a.example.com/1", doritos), snippetFinding("https://b.example.com/2", doritos)],
      "balanced",
    );
    expect(d.outcome).not.toBe("verified");
    expect(d.rulesFired.some((r) => r.includes("snippet consensus: 2 hosts agree"))).toBe(true);
  });

  test("duplicate hosts collapse to one entry before the 3-host threshold is checked", () => {
    // Same host repeated 3x is still only 1 distinct host - must not reach the 3-host tier.
    const d = decideOutcome(
      pubId,
      [
        snippetFinding("https://a.example.com/1", doritos),
        snippetFinding("https://a.example.com/2", doritos),
        snippetFinding("https://a.example.com/3", doritos),
      ],
      "balanced",
    );
    expect(d.outcome).not.toBe("verified");
  });

  test("snippet conflict scan runs BEFORE the verify block: 2 agreeing snippets + 1 disagreeing => needs_review, not verified", () => {
    const nacho = { ...doritos, name: "Doritos Nacho Cheese Tortilla Chips 9.25 oz" };
    const unrelated = { ...doritos, name: "Shin Megami Tensei Deluxe Box PlayStation 2", brand: "" };
    const d = decideOutcome(
      pubId,
      [
        snippetFinding("https://a.example.com/1", doritos),
        snippetFinding("https://b.example.com/2", nacho),
        snippetFinding("https://c.example.com/3", unrelated),
      ],
      "balanced",
    );
    expect(d.outcome).toBe("needs_review");
    expect(d.rulesFired.some((r) => r.startsWith("snippet conflict guard"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------- snippet-only identity gating
describe("decideOutcome: snippet-only identity needs a label or 2+ agreeing hosts", () => {
  test("a single unlabeled snippet on one host produces NO identity at all (unknown, not suggested)", () => {
    const d = decideOutcome(
      pubId,
      [
        {
          url: "https://a.example.com/1",
          association: { level: "weak", matchedVariant: CODE, matchedField: "search_snippets", product: doritos },
          product: doritos,
          junkRejected: false,
          junkReasons: [],
          quality: "weak",
          score: 30,
          labeled: false,
        },
      ],
      "balanced",
    );
    expect(d.outcome).toBe("unknown");
    expect(d.rulesFired.some((r) => r.includes("no barcode label and fewer than 2 agreeing hosts"))).toBe(true);
  });

  test("a single LABELED snippet is enough to produce a suggestion", () => {
    const d = decideOutcome(
      pubId,
      [
        {
          url: "https://a.example.com/1",
          association: { level: "weak", matchedVariant: CODE, matchedField: "search_snippets", product: doritos },
          product: doritos,
          junkRejected: false,
          junkReasons: [],
          quality: "weak",
          score: 30,
          labeled: true,
        },
      ],
      "balanced",
    );
    expect(d.outcome).toBe("suggested");
  });
});

// ---------------------------------------------------------------------------- rulesFired trace strings
describe("decideOutcome: rulesFired always explains the winning path", () => {
  test("strict mode records its own rule string on verify", () => {
    const d = decideOutcome(
      pubId,
      [finding({}), finding({ quality: "medium", score: 55, url: "https://world.openfoodfacts.org/product/0" + CODE })],
      "strict",
    );
    expect(d.rulesFired).toContain("strict: strong source + independent agreeing corroboration");
  });

  test("fast/balanced single-strong-source verify records the mode-qualified rule string", () => {
    const d = decideOutcome(pubId, [finding({})], "fast");
    expect(d.rulesFired).toContain("fast: single strong source with proven code-to-product association");
  });

  test("a plain suggestion (weak evidence, non-snippet) records the generic usable-identity rule", () => {
    const d = decideOutcome(pubId, [finding({ association: weakAssoc, quality: "weak", score: 30 })], "balanced");
    expect(d.rulesFired).toContain("usable identity without verification-grade proof");
  });

  test("no identity anywhere records the final fallback rule", () => {
    const d = decideOutcome(pubId, [finding({ association: noAssoc, product: null, quality: "weak", score: 10 })], "balanced");
    expect(d.outcome).toBe("unknown");
    expect(d.rulesFired).toContain("sources fetched but no identity/evidence found");
  });
});
