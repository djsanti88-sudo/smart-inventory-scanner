import { describe, it, expect } from "vitest";
import { isSensitiveKey, stripSensitive, SENSITIVE_FIELDS } from "./sensitiveFields";
import { isPlatformOwnerIdentity, accessLevelClient } from "@/users-businesses/roles/roleAccess";
import { sanitizeProduct, sanitizeScanResult, sanitizeForBusiness } from "./serializers";

const ALLOW = { emails: ["djsanti88@gmail.com"], uids: ["ndpz45mqdmaaucovnl4y5v5vhsh3"] };

describe("platformOwner identity", () => {
  it("matches by email or uid (case-insensitive)", () => {
    expect(isPlatformOwnerIdentity({ email: "DJsanti88@gmail.com" }, ALLOW)).toBe(true);
    expect(isPlatformOwnerIdentity({ uid: "nDPz45mqDMaaucovnl4y5v5vhSH3" }, ALLOW)).toBe(true);
  });
  it("does NOT treat a business owner/admin as platformOwner", () => {
    expect(isPlatformOwnerIdentity({ email: "shopowner@somebody.com", uid: "biz-123" }, ALLOW)).toBe(false);
    // a businessId that looks like biz-<uid> must not match the uid allowlist
    expect(isPlatformOwnerIdentity({ uid: "biz-nDPz45mqDMaaucovnl4y5v5vhSH3" }, ALLOW)).toBe(false);
  });
});

describe("sensitive field denylist", () => {
  it("flags code/alias/provider fields", () => {
    for (const f of ["aliases", "gtin", "upc", "ean", "cleanCode", "rawCode", "providerName", "sourceUrls"]) {
      expect(isSensitiveKey(f)).toBe(true);
    }
    expect(isSensitiveKey("name")).toBe(false);
    expect(isSensitiveKey("brand")).toBe(false);
  });
  it("stripSensitive removes nested sensitive keys", () => {
    const out = stripSensitive({ name: "Falken", gtin: "x", inner: { aliases: ["a"], category: "Tire" }, list: [{ upc: "1", brand: "F" }] }) as Record<string, unknown>;
    expect(out.name).toBe("Falken");
    expect("gtin" in out).toBe(false);
    expect("aliases" in (out.inner as object)).toBe(false);
    expect((out.inner as Record<string, unknown>).category).toBe("Tire");
    expect("upc" in (out.list as Record<string, unknown>[])[0]).toBe(false);
  });
  it("denylist includes the user-named sensitive fields", () => {
    for (const f of ["barcode", "normalizedCode", "globalCatalogId", "decodeTrace", "aiProvider", "prompt"]) {
      expect((SENSITIVE_FIELDS as readonly string[]).map((x) => x.toLowerCase())).toContain(f.toLowerCase());
    }
  });
});

describe("product serialization by role", () => {
  const product = { id: "p1", name: "Falken", brand: "Falken", category: "Tire", specsShort: "215/70R15", primarySku: "28816861", primaryBarcode: "848983012906", gtin: "848983012906", upc: "", ean: "", aliases: ["28816861", "2881-6861"], vendorCodes: ["x"], imageUrl: "", location: "Bay A", notes: "", status: "active" };
  it("platformOwner gets aliases/UPC/EAN/GTIN/barcode", () => {
    const p = sanitizeProduct(product, "platform") as typeof product;
    expect(p.aliases).toEqual(["28816861", "2881-6861"]);
    expect(p.gtin).toBe("848983012906");
    expect(p.primaryBarcode).toBe("848983012906");
  });
  it("business role strips aliases/vendorCodes (the reusable alias/catalog corpus); keeps name/brand/part number/the shop's own scanned barcode", () => {
    const p = sanitizeProduct(product, "business") as Record<string, unknown>;
    expect(p.name).toBe("Falken");
    expect(p.primarySku).toBe("28816861"); // part number is product-facing (allowed)
    // Owner rule (2026-07-22): the barcode a shop scanned onto THEIR OWN product row is their data -
    // already rendered to every role (FinalCountTable.tsx:129-131) - so it survives at business level.
    expect(p.primaryBarcode).toBe("848983012906");
    expect(p.gtin).toBe("848983012906");
    // The reusable alias/catalog corpus (many-code-to-one-product mapping, vendor labels) stays platform-only.
    expect("aliases" in p).toBe(false);
    expect("vendorCodes" in p).toBe(false);
  });
});

describe("scan result serialization by role", () => {
  const result = { resolverStatus: "known", matchedProductId: "p1", rawCode: "2881-6861", cleanCode: "2881-6861", normalizedCandidates: ["28816861"], quantityAfterScan: 2, reason: "Matched Falken via an approved alias.", product: { name: "Falken", brand: "Falken", category: "Tire", primarySku: "28816861", gtin: "848983012906", aliases: ["x"] } };
  it("business result has product info, NO raw/clean/normalized codes, NO aliases/gtin", () => {
    const r = sanitizeScanResult(result, "business") as Record<string, unknown>;
    expect(r.matchStatus).toBe("known");
    expect(r.productName).toBe("Falken");
    expect(r.partNumber).toBe("28816861");
    for (const k of ["rawCode", "cleanCode", "normalizedCandidates", "gtin", "aliases", "product"]) {
      expect(k in r).toBe(false);
    }
  });
  it("platformOwner result keeps full internal fields", () => {
    const r = sanitizeScanResult(result, "platform") as typeof result;
    expect(r.rawCode).toBe("2881-6861");
    expect(r.product.aliases).toEqual(["x"]);
  });
});

describe("sanitizeForBusiness (defense in depth)", () => {
  it("strips any sensitive keys from an arbitrary payload", () => {
    const out = sanitizeForBusiness({ ok: 1, gtin: "x", list: [{ aliases: [], name: "n" }] }) as Record<string, unknown>;
    expect(out.ok).toBe(1);
    expect("gtin" in out).toBe(false);
    expect("aliases" in (out.list as Record<string, unknown>[])[0]).toBe(false);
  });
  it("accessLevelClient defaults to business when no env allowlist", () => {
    expect(accessLevelClient({ email: "x@y.com" })).toBe("business");
  });
});
