import { describe, expect, it } from "vitest";
import { decodeLinkCursor, decodeReviewCursor, encodeLinkCursor, encodeReviewCursor } from "./reviewCursor";

const token = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const review = { version: 1, kind: "review", businessId: "shop-a", bucket: "review", reviewId: "r-1" };
const link = { version: 1, kind: "link", businessId: "shop-a", normalizedValue: "sku-1", familyKey: "family-1" };

describe("identity review cursors", () => {
  it("accepts only exact canonical approved schemas", () => {
    expect(decodeReviewCursor(token(review), "shop-a", "review")).toEqual({ reviewId: "r-1" });
    expect(decodeLinkCursor(token(link), "shop-a")).toEqual({ normalizedValue: "sku-1", familyKey: "family-1" });
  });

  it("rejects malformed review representations and bindings", () => {
    const malformed = ["", "abc=", "abc!", token(null), token([]), token(1), token({ ...review, extra: true }), token({ version: 1, kind: "review", businessId: "shop-a", bucket: "review" }), Buffer.from('{ "version":1,"kind":"review","businessId":"shop-a","bucket":"review","reviewId":"r-1"}', "utf8").toString("base64url"), Buffer.from('{"version":1,"kind":"review","businessId":"shop-a","bucket":"review","reviewId":"r-1","reviewId":"r-2"}', "utf8").toString("base64url"), token({ ...review, version: 2 }), token({ ...review, kind: "link" }), token({ ...review, reviewId: "" }), token({ ...review, reviewId: "a\0b" }), token({ ...review, reviewId: "x".repeat(513) }), "a".repeat(513), Buffer.from("x".repeat(513), "utf8").toString("base64url")];
    for (const raw of malformed) expect(() => decodeReviewCursor(raw, "shop-a", "review")).toThrow("invalid_identity_cursor");
    expect(() => decodeReviewCursor(token(review), "shop-b", "review")).toThrow("invalid_identity_cursor");
    expect(() => decodeReviewCursor(token(review), "shop-a", "automatic")).toThrow("invalid_identity_cursor");
  });

  it("rejects malformed link representations and cross-tenant bindings", () => {
    const malformed = [token({ ...link, extra: true }), token({ version: 1, kind: "link", businessId: "shop-a", normalizedValue: "sku-1" }), token({ ...link, kind: "review" }), token({ ...link, normalizedValue: 1 }), token({ ...link, familyKey: "" }), token({ ...link, familyKey: "a\0b" }), token({ ...link, normalizedValue: "x".repeat(513) })];
    for (const raw of malformed) expect(() => decodeLinkCursor(raw, "shop-a")).toThrow("invalid_identity_cursor");
    expect(() => decodeLinkCursor(token(link), "shop-b")).toThrow("invalid_identity_cursor");
  });

  it("encoders never emit a token their decoder rejects and reject oversize tuples", () => {
    let reviewLength = 1;
    while (true) { try { encodeReviewCursor("shop-a", "review", { reviewId: "r".repeat(reviewLength + 1) }); reviewLength += 1; } catch { break; } }
    let linkLength = 1;
    while (true) { try { encodeLinkCursor("shop-a", { normalizedValue: "l".repeat(linkLength + 1), familyKey: "l".repeat(linkLength + 1) }); linkLength += 1; } catch { break; } }
    const maxReview = "r".repeat(reviewLength);
    const maxLink = "l".repeat(linkLength);
    const encodedReview = encodeReviewCursor("shop-a", "review", { reviewId: maxReview });
    const encodedLink = encodeLinkCursor("shop-a", { normalizedValue: maxLink, familyKey: maxLink });
    expect(encodedReview.length).toBeLessThanOrEqual(512);
    expect(encodedLink.length).toBeLessThanOrEqual(512);
    expect(decodeReviewCursor(encodedReview, "shop-a", "review")).toEqual({ reviewId: maxReview });
    expect(decodeLinkCursor(encodedLink, "shop-a")).toEqual({ normalizedValue: maxLink, familyKey: maxLink });
    expect(() => encodeReviewCursor("shop-a", "review", { reviewId: "r".repeat(reviewLength + 1) })).toThrow("invalid_identity_cursor");
    expect(() => encodeLinkCursor("shop-a", { normalizedValue: "l".repeat(linkLength + 1), familyKey: "l".repeat(linkLength + 1) })).toThrow("invalid_identity_cursor");
  });
});
