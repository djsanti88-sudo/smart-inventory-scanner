import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, getDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { FirebaseSyncTarget } from "@/services/db/firebase/firebaseSyncTarget";
import type { PendingSyncItem } from "@/types";

// Regression for campaign #32 (task P1b). A counter may create their own active-session row, and the
// FIX (a narrow counter-update escape hatch on products/scanEvents/unknownCodeReviews) now lets the
// next distinct decode/settlement edit of that SAME entity (fresh idempotency key) succeed too, instead
// of being permanently denied. The escape hatch is scoped to: same business (path-derived), tenancy
// field immutable, and (for scanEvents/unknownCodeReviews) the counter's own active session at write
// time. Cross-tenant writes and auditLog immutability are pinned as adversarial regressions.
const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "";
const ready = HOSTPORT.includes(":");
const UID = "campaignCounter";
const BIZ = "default_df9806fe13f1be332f639a1a8060f328";
const SID = "campaign-active-session";
const OTHER_UID = "otherBizCounter";
const OTHER_BIZ = "default_other_business_9f1c2a";
const OTHER_SID = "other-active-session";

function eventItem(key: string, decodeStatus?: string): PendingSyncItem {
  return {
    id: `queue-${key}`,
    businessId: BIZ,
    sessionId: SID,
    entityType: "ScanEvent",
    entityId: "campaign-event",
    operation: "SAVE_SCAN_EVENT",
    payload: {
      id: "campaign-event",
      businessId: BIZ,
      sessionId: SID,
      rawCode: "8848116004503",
      cleanCode: "8848116004503",
      // Required per the real ScanEvent schema (ensureProvisionalCount always assigns one synchronously
      // before any network/decode activity - TOP-LEVEL LAW). Pinned to the SAME provisional product id
      // across create + re-save here: this is the common non-merge decode-settle case (panel MUST-FIX 2
      // now pins matchedProductId immutable across a re-save; the merge-to-a-different-product case is a
      // separate, reported trade-off - see task-p1b-report.md).
      matchedProductId: "campaign-provisional-product",
      quantityDelta: 1,
      createdAt: "2026-08-05T00:00:00.000Z",
      decodeStatus,
    },
    status: "pending",
    retryCount: 0,
    lastError: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: key,
    scanEventId: "campaign-event",
  };
}

describe.skipIf(!ready)("FirebaseSyncTarget counter retry classification (emulator)", () => {
  let env: RulesTestEnvironment;
  const target = () => new FirebaseSyncTarget(
    env.authenticatedContext(UID).firestore() as unknown as Firestore,
    { emulator: true },
  );

  beforeAll(async () => {
    const [host, port] = HOSTPORT.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-sync-retry",
      firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
    });
  });
  afterAll(async () => { if (env) await env.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businesses", BIZ), { name: "Campaign business", createdBy: UID });
      await setDoc(doc(db, "businessMembers", `${BIZ}_${UID}`), { businessId: BIZ, userId: UID, role: "counter" });
      await setDoc(doc(db, "businesses", BIZ, "countSessions", SID), {
        id: SID, businessId: BIZ, createdBy: UID, status: "active", locked: false,
      });
      await setDoc(doc(db, "businesses", OTHER_BIZ), { name: "Other business", createdBy: OTHER_UID });
      await setDoc(doc(db, "businessMembers", `${OTHER_BIZ}_${OTHER_UID}`), {
        businessId: OTHER_BIZ, userId: OTHER_UID, role: "counter",
      });
      await setDoc(doc(db, "businesses", OTHER_BIZ, "countSessions", OTHER_SID), {
        id: OTHER_SID, businessId: OTHER_BIZ, createdBy: OTHER_UID, status: "active", locked: false,
      });
    });
  });

  it("keeps same-key retry idempotent and lets a fresh-key counter re-save of its own event succeed", async () => {
    const t = target();
    const first = eventItem("campaign-event-create");
    expect(await t.apply(first)).toMatchObject({ ok: true, alreadyApplied: false });

    // Simulated post-commit retry: its marker exists, so it must never become an error.
    expect(await t.apply(first)).toMatchObject({ ok: true, alreadyApplied: true });

    // Decode settlement re-saves the same event with a deliberately fresh key. Before the P1b rules
    // fix this was a terminal permission_denied; the narrow counter-update escape hatch now lets it
    // through end to end.
    const settled = await t.apply(eventItem("campaign-event-decode-settlement", "suggested"));
    expect(settled).toMatchObject({ ok: true, alreadyApplied: false });

    const readCtx = env.authenticatedContext(UID).firestore();
    const stored = await getDoc(doc(readCtx, "businesses", BIZ, "scanEvents", "campaign-event"));
    const data = stored.data();
    expect(data?.decodeStatus).toBe("suggested");
    // Identity fields the rule pins stay unchanged across the re-save.
    expect(data?.businessId).toBe(BIZ);
    expect(data?.id).toBe("campaign-event");
    expect(data?.sessionId).toBe(SID);
    expect(data?.createdAt).toBe("2026-08-05T00:00:00.000Z");
  });

  it("FIX-ROUND-1 ITEM 4 (priority): full legit settlement (verified:true) via apply() must succeed, marker included", async () => {
    // Reproduces Gemini's C4: counterProductMarkerOk's getAfter check required the POST-state to still
    // satisfy counterProductDataOk (verified==false), but legit trusted-exact settlement writes
    // verified:true in the SAME transaction as the _appliedKeys marker create. Since Firestore
    // transactions are atomic, that marker-create denial fails the WHOLE apply(), not just the field.
    const t = target();
    const productId = "campaign-settlement-product";
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "businesses", BIZ, "products", productId), {
        id: productId, businessId: BIZ, provisional: true, verified: false, status: "active",
        source: "ai_openai", createdBy: "ai", updatedBy: "ai", name: "Unidentified item", brand: "",
        createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
      });
    });
    const settleItem: PendingSyncItem = {
      id: "queue-settle", businessId: BIZ, sessionId: SID, entityType: "Product", entityId: productId,
      operation: "SAVE_PRODUCT",
      payload: {
        id: productId, businessId: BIZ, provisional: false, verified: true, status: "active",
        source: "catalog", name: "Decoded Widget 4x4", brand: "Acme", confidence: 1,
        provenanceTier: "corpus_verified", trustedExactCanonicalId: "canon-1", updatedBy: "system:trusted_exact",
      },
      status: "pending", retryCount: 0, lastError: null,
      createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
      idempotencyKey: "campaign-settlement-key", scanEventId: null,
    };
    const result = await t.apply(settleItem);
    expect(result).toMatchObject({ ok: true, alreadyApplied: false });

    const readCtx = env.authenticatedContext(UID).firestore();
    const stored = await getDoc(doc(readCtx, "businesses", BIZ, "products", productId));
    expect(stored.data()?.verified).toBe(true);
    expect(stored.data()?.provisional).toBe(false);
  });

  it("lets a counter's fresh-key re-save of its own provisional product succeed (decode enrichment)", async () => {
    const productRef = env.authenticatedContext(UID).firestore();
    const path = ["businesses", BIZ, "products", "campaign-product"] as const;
    const base = {
      id: "campaign-product",
      businessId: BIZ,
      provisional: true,
      verified: false,
      status: "active",
      source: "ai_openai",
      createdBy: "ai",
      updatedBy: "ai",
      name: "Unidentified item",
      brand: "",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), base);
    });
    await assertSucceeds(updateDoc(doc(productRef, ...path), {
      name: "Decoded Widget 4x4",
      brand: "Acme",
      // Still a counter-owned unverified provisional row after the write.
      provisional: true,
      verified: false,
    }));
  });

  it("lets a counter's fresh-key re-save of its own unknownCodeReview succeed (trusted-exact settlement)", async () => {
    const reviewCtx = env.authenticatedContext(UID).firestore();
    const path = ["businesses", BIZ, "unknownCodeReviews", "campaign-review"] as const;
    const base = {
      id: "campaign-review",
      businessId: BIZ,
      sessionId: SID,
      rawCode: "8848116004503",
      cleanCode: "8848116004503",
      status: "open",
      createdAt: "2026-08-05T00:00:00.000Z",
    };
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), base);
    });
    // Mirrors the exact shape scanStore.ts's settledReview produces (status open/suggested -> resolved,
    // resolvedBy/resolutionAction/exactCodeEvidenceVerifiedByApp set together) - the only status
    // transition counterUnknownResolutionOk allows.
    await assertSucceeds(updateDoc(doc(reviewCtx, ...path), {
      status: "resolved",
      resolvedBy: "system:trusted_exact",
      resolutionAction: "trusted_exact",
      exactCodeEvidenceVerifiedByApp: true,
      // createdAt is intentionally NOT pinned here: FirebaseSyncTarget.apply() stamps a fresh
      // serverTimestamp() into it on every unknownCodeReviews write (see counterUnknownUpdateOk).
      createdAt: new Date().toISOString(),
    }));
  });

  it("denies a counter of business A updating a business-B scan event (adversarial: cross-tenant)", async () => {
    const otherPath = ["businesses", OTHER_BIZ, "scanEvents", "other-event"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...otherPath), {
        id: "other-event", businessId: OTHER_BIZ, sessionId: OTHER_SID,
        quantityDelta: 1, createdAt: "2026-08-05T00:00:00.000Z", decodeStatus: "pending",
      });
    });
    const crossTenantCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(crossTenantCtx, ...otherPath), { decodeStatus: "suggested" }));
  });

  it("denies a counter changing businessId on update (adversarial: tenancy tamper)", async () => {
    const path = ["businesses", BIZ, "scanEvents", "campaign-event"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "campaign-event", businessId: BIZ, sessionId: SID,
        quantityDelta: 1, createdAt: "2026-08-05T00:00:00.000Z", decodeStatus: "pending",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), { businessId: OTHER_BIZ, decodeStatus: "suggested" }));
  });

  // ----- Fix round 1 (panel adjudication, panel-adjudication.md) adversarial matrix -----

  it("denies a counter smuggling unitCost into a product update (adversarial: panel MUST-FIX 1)", async () => {
    const path = ["businesses", BIZ, "products", "campaign-product-cost"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "campaign-product-cost", businessId: BIZ, provisional: true, verified: false, status: "active",
        source: "ai_openai", createdBy: "ai", updatedBy: "ai", name: "Unidentified item", brand: "",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), {
      name: "Decoded Widget", brand: "Acme", unitCost: 999,
    }));
  });

  it("denies a counter grafting aliases onto a product update (adversarial: panel MUST-FIX 1)", async () => {
    const path = ["businesses", BIZ, "products", "campaign-product-alias"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "campaign-product-alias", businessId: BIZ, provisional: true, verified: false, status: "active",
        source: "ai_openai", createdBy: "ai", updatedBy: "ai", name: "Unidentified item", brand: "", aliases: [],
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), {
      name: "Decoded Widget", aliases: ["stolen-alias-code"],
    }));
  });

  it("denies a counter forging verified:true on a product it does not own (adversarial: verified forgery outside allowlist)", async () => {
    // BEFORE state is already owner-managed (verified:true, not provisional) - counterProductUpdateOk's
    // ownership gate (counterProductDataOk on the BEFORE doc) must reject this outright, regardless of
    // what the update itself contains.
    const path = ["businesses", BIZ, "products", "owner-product"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "owner-product", businessId: BIZ, provisional: false, verified: true, status: "active",
        name: "Real Product", brand: "Real Brand",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), { name: "Hijacked Name" }));
  });

  it("denies a counter remapping matchedProductId on a scan event (adversarial: panel MUST-FIX 2, count-remap forgery)", async () => {
    const path = ["businesses", BIZ, "scanEvents", "remap-event"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "remap-event", businessId: BIZ, sessionId: SID, rawCode: "111", cleanCode: "111",
        matchedProductId: "product-a", quantityDelta: 1, createdAt: "2026-08-05T00:00:00.000Z",
        decodeStatus: "pending",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), {
      matchedProductId: "product-b-victim", decodeStatus: "suggested",
    }));
  });

  it("denies a counter rewriting a scan event's rawCode/cleanCode (adversarial: panel MUST-FIX 2)", async () => {
    const path = ["businesses", BIZ, "scanEvents", "recode-event"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "recode-event", businessId: BIZ, sessionId: SID, rawCode: "111", cleanCode: "111",
        matchedProductId: "product-a", quantityDelta: 1, createdAt: "2026-08-05T00:00:00.000Z",
        decodeStatus: "pending",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), { rawCode: "222", cleanCode: "222" }));
  });

  it("denies a counter rewriting an unknownCodeReview's rawCode/cleanCode (adversarial: panel MUST-FIX 3)", async () => {
    const path = ["businesses", BIZ, "unknownCodeReviews", "recode-review"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "recode-review", businessId: BIZ, sessionId: SID, rawCode: "111", cleanCode: "111",
        status: "open",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(counterCtx, ...path), { rawCode: "222", cleanCode: "222" }));
  });

  it("denies a counter impersonating resolvedBy without the valid trusted_exact transition (adversarial: panel MUST-FIX 3)", async () => {
    const path = ["businesses", BIZ, "unknownCodeReviews", "impersonate-review"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "impersonate-review", businessId: BIZ, sessionId: SID, rawCode: "111", cleanCode: "111",
        status: "open",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    // status stays "open" (untouched) while resolvedBy is smuggled in alone - must be denied because
    // counterUnknownResolutionOk requires resolvedBy/resolutionAction/resolvedAt/
    // exactCodeEvidenceVerifiedByApp to ALL stay unchanged unless the full valid transition fires.
    await assertFails(updateDoc(doc(counterCtx, ...path), { resolvedBy: "some-human-uid" }));
  });

  it("denies a counter resolving a review with a fabricated status transition (adversarial: panel MUST-FIX 3)", async () => {
    const path = ["businesses", BIZ, "unknownCodeReviews", "fake-resolve-review"] as const;
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ...path), {
        id: "fake-resolve-review", businessId: BIZ, sessionId: SID, rawCode: "111", cleanCode: "111",
        status: "open",
      });
    });
    const counterCtx = env.authenticatedContext(UID).firestore();
    // Sets status: resolved but resolvedBy to something other than the system:trusted_exact shape.
    await assertFails(updateDoc(doc(counterCtx, ...path), {
      status: "resolved", resolvedBy: "counter-self-resolved", resolutionAction: "trusted_exact",
      exactCodeEvidenceVerifiedByApp: true,
    }));
  });

  it("keeps auditLog update denied for every role, including owner (regression pin)", async () => {
    const ownerUid = "campaignOwner";
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "businessMembers", `${BIZ}_${ownerUid}`), {
        businessId: BIZ, userId: ownerUid, role: "owner",
      });
      await setDoc(doc(db, "businesses", BIZ, "auditLog", "entry-1"), {
        businessId: BIZ, action: "scan", createdAt: "2026-08-05T00:00:00.000Z",
      });
    });
    const ownerCtx = env.authenticatedContext(ownerUid).firestore();
    await assertFails(updateDoc(doc(ownerCtx, "businesses", BIZ, "auditLog", "entry-1"), {
      action: "tampered",
    }));
  });
});
