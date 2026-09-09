import type { InventoryCount, PendingSyncItem, Product } from "@/types";
import type { IncrementPayload } from "@/sync-database/mock/mockDb";
import { buildIdempotencyKey, stableIdempotencyFingerprint } from "@/inventory/idempotency";
import { parseCsv, buildProductImport } from "@/import/csvImport";
import { buildCleanupRecommendations } from "@/inventory/cleanup/recommendations";
import { codeFromNamePrefix, normCodeToken } from "@/products/match/productDedup";
import { makeQueueItem } from "@/stores/scan/queueItem";
import { deleteProductsInternal, POISON_CODES, productIdentityCodes } from "@/stores/scan/productDelete";
import { applyImportedUnitCosts } from "@/stores/scanStore";
import type { CleanupBackup, ScanState, ScanStoreDeps } from "@/stores/scanStore";

export function createCatalogSlice(ctx: {
  set: (partial: Partial<ScanState> | ((s: ScanState) => Partial<ScanState>)) => void;
  get: () => ScanState;
  deps: ScanStoreDeps;
  idFactory: () => string;
  now: () => string;
  emitAudit: (e: { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> }) => void;
  enqueueAndSync: (items: PendingSyncItem[]) => void;
}): Pick<ScanState,
  "importProductsCsv" | "auditCsvExport" | "getProduct" | "applyCleanupSelections" |
  "cleanupJunkCounts" | "undoCleanup" | "deleteProduct" | "purgePoisonedProducts" |
  "undoDeleteProduct" | "previewIdentifierBackfill" | "applyIdentifierBackfill" |
  "undoIdentifierBackfill"> {
  const { set, get, idFactory, now, emitAudit, enqueueAndSync } = ctx;

  return {
      importProductsCsv: (text) => {
        const state = get();
        const { rows } = parseCsv(text);
        const plan = buildProductImport({
          rows,
          existingProducts: state.products,
          existingAliases: state.aliases,
          businessId: state.businessId,
          idFactory,
          now,
        });
        applyImportedUnitCosts(rows, plan.products);

        if (plan.products.length > 0 || plan.aliases.length > 0 || plan.refreshedProducts.length > 0) {
          set((s) => {
            const refreshedById = new Map(plan.refreshedProducts.map((p) => [p.id, p]));
            return {
              products: [
                ...s.products.map((p) => refreshedById.get(p.id) ?? p),
                ...plan.products,
              ],
              aliases: [...s.aliases, ...plan.aliases],
            };
          });

          // Queue idempotent SAVE_PRODUCT (each new product) BEFORE its aliases, then RESOLVE_ALIAS, so a
          // reloaded alias always references a persisted product. Same durable path Loop 4 proved.
          // QA Task 7: a refreshed (existing-barcode) product is ALSO queued as SAVE_PRODUCT with the
          // SAME entity id so it upserts. Its key includes an exact stable payload fingerprint so a
          // later import with changed content cannot collide with the earlier durable write. The key is
          // minted once here and retained on PendingSyncItem for every retry.
          const items: PendingSyncItem[] = [];
          for (const p of [...plan.products, ...plan.refreshedProducts]) {
            const productVersion = stableIdempotencyFingerprint(p);
            items.push(makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: state.sessionId,
              entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: p,
              idempotencyKey: buildIdempotencyKey(
                state.businessId,
                state.sessionId,
                `${p.id}:${productVersion}`,
                "SAVE_PRODUCT",
              ),
              scanEventId: null,
              syncLane: "independent_product",
            }));
          }
          for (const a of plan.aliases) {
            items.push(makeQueueItem({
              idFactory, now, businessId: state.businessId, sessionId: state.sessionId,
              entityType: "Alias", entityId: a.id, operation: "RESOLVE_ALIAS", payload: a,
              idempotencyKey: a.idempotencyKey, scanEventId: null,
            }));
          }
          enqueueAndSync(items);
        }

        emitAudit({
          entityType: "ImportBatch",
          entityId: `import-${idFactory()}`,
          action: "csv_import",
          metadata: {
            rowsParsed: plan.rowsParsed,
            productsCreated: plan.products.length,
            aliasesCreated: plan.aliases.length,
            duplicates: plan.duplicates.length,
            conflicts: plan.conflicts.length,
            refreshed: plan.refreshed.length,
          },
        });

        return {
          rowsParsed: plan.rowsParsed,
          productsCreated: plan.products.length,
          aliasesCreated: plan.aliases.length,
          duplicates: plan.duplicates.length,
          conflicts: plan.conflicts,
          refreshed: plan.refreshed.length,
        };
      },

      auditCsvExport: (kind, rowCount, format) => {
        // Backward-compatible: action + entityId unchanged; format defaults to "csv" so existing 2-arg
        // callers and the csvImport audit test keep working, while new multi-format exports record which.
        emitAudit({ entityType: "Export", entityId: kind, action: "csv_export", metadata: { kind, rowCount, format: format ?? "csv" } });
      },

      getProduct: (id) => (id ? get().products.find((p) => p.id === id) : undefined),

      applyCleanupSelections: (selectedCountIds) => {
        const state = get();
        const sel = new Set(selectedCountIds);
        const removedCounts = state.finalCounts.filter((c) => sel.has(c.id));
        if (removedCounts.length === 0) return { removed: 0, backup: null };

        const remainingCounts = state.finalCounts.filter((c) => !sel.has(c.id));
        const survivingProductIds = new Set(remainingCounts.map((c) => c.productId));
        // Remove a product/alias ONLY when no surviving count references it AND it is not a protected
        // (seed/manual) product. Good rows can never lose their product.
        const removableProductIds = new Set(
          removedCounts
            .map((c) => c.productId)
            .filter((pid) => {
              if (survivingProductIds.has(pid)) return false;
              const p = state.products.find((x) => x.id === pid);
              return !!p && p.source !== "seed" && p.source !== "manual";
            }),
        );

        const backup: CleanupBackup = {
          removedCounts,
          removedProducts: state.products.filter((p) => removableProductIds.has(p.id)),
          removedAliases: state.aliases.filter((a) => removableProductIds.has(a.productId)),
          removedAt: now(),
        };

        set({
          finalCounts: remainingCounts,
          products: state.products.filter((p) => !removableProductIds.has(p.id)),
          aliases: state.aliases.filter((a) => !removableProductIds.has(a.productId)),
          lastCleanupBackup: backup,
        });
        get().recordFeedback("ran_cleanup", { code: "", meta: { removed: removedCounts.length } });
        return { removed: removedCounts.length, backup };
      },

      cleanupJunkCounts: () => {
        const { finalCounts, products, aliases, catalog } = get();
        const { recommendations } = buildCleanupRecommendations({ finalCounts, products, aliases, catalog });
        const highIds = recommendations.filter((r) => r.defaultChecked).map((r) => r.id);
        return get().applyCleanupSelections(highIds);
      },

      undoCleanup: () => {
        const backup = get().lastCleanupBackup;
        if (!backup) return false;
        // Restore additively (dedupe by id) so any scans made after the cleanup are preserved.
        const mergeById = <T extends { id: string }>(current: T[], restored: T[]): T[] => {
          const ids = new Set(current.map((x) => x.id));
          return [...current, ...restored.filter((x) => !ids.has(x.id))];
        };
        set((s) => ({
          finalCounts: mergeById(s.finalCounts, backup.removedCounts),
          products: mergeById(s.products, backup.removedProducts),
          aliases: mergeById(s.aliases, backup.removedAliases),
          lastCleanupBackup: null,
        }));
        get().recordFeedback("restored_cleanup", { code: "", meta: { restored: backup.removedCounts.length } });
        return true;
      },

      deleteProduct: (productId) => {
        const r = deleteProductsInternal(get, set, emitAudit, now, idFactory, [productId], "product_deleted");
        return r.backup;
      },

      purgePoisonedProducts: () => {
        // Targeted, safe purge of the known poison: NON-protected (non seed/manual) products whose identity
        // is the poison code 745125495781, or whose name is a rivet/Manstel kit sitting on that code. Seed/
        // manual products are never touched. Reversible via undoDeleteProduct. (The persist version bump
        // additionally resets every browser's local cache to clean seed on next load.)
        const state = get();
        const ids = state.products
          .filter((p) => {
            if (p.source === "seed" || p.source === "manual") return false;
            const codes = productIdentityCodes(p, state.aliases);
            const onPoison = codes.some((c) => POISON_CODES.has(c));
            const rivet = /\bmanstel\b|\brivet\b/i.test(`${p.name} ${p.brand}`);
            return onPoison || (rivet && codes.some((c) => POISON_CODES.has(c)));
          })
          .map((p) => p.id);
        if (ids.length === 0) return { removed: 0, backup: null };
        const r = deleteProductsInternal(get, set, emitAudit, now, idFactory, ids, "product_purged");
        return { removed: ids.length, backup: r.backup };
      },

      undoDeleteProduct: () => {
        const backup = get().lastProductDeleteBackup;
        if (!backup) return false;
        // EXACT restore: put the product/alias/count rows back as they were, restore the catalog/shop
        // entries, and re-attach the scan-feed rows. Replace-by-id so a row that still exists (archived) is
        // restored to its pre-delete value; rows fully removed (counts) are re-added.
        const upsertById = <T extends { id: string }>(current: T[], restored: T[]): T[] => {
          const map = new Map(current.map((x) => [x.id, x]));
          for (const x of restored) map.set(x.id, x);
          return [...map.values()];
        };
        const restoredProductIds = new Set(backup.products.map((p) => p.id));
        const feedById = new Map(backup.feed.map((e) => [e.id, e]));
        // SYNC THE UNDO (reviewed defect 2026-07-22): the delete shipped archive + transfer ops to the
        // backend, so a local-only restore is silently re-reverted by the next refreshFromCloud - the
        // remote still says "archived + quantity on the provisional", the products merge re-deletes the
        // undone product, and the remote provisional row re-adds the transferred quantity ALONGSIDE the
        // restored local row (2 became 4). Mirror every delete op with a compensator: a restore
        // SAVE_PRODUCT per product, a reverse transfer PAIR per backed-up count row (net zero per
        // session), and an archive SAVE_PRODUCT for a minted provisional the undo removes. Compensators
        // APPEND after any still-pending delete ops, so undoing before the queue drains nets out to the
        // same restored remote state. Keys are distinct from the delete's, so the backend dedupe never
        // swallows the reversal.
        const s0 = get();
        const bid = s0.businessId;
        const liveCountById = new Map(s0.finalCounts.map((c) => [c.id, c]));
        const mintedProducts = s0.products.filter((p) => (backup.mintedProvisionalIds ?? []).includes(p.id));
        const syncOps: PendingSyncItem[] = [];
        for (const p of backup.products) {
          syncOps.push(
            makeQueueItem({ idFactory, now, businessId: bid, sessionId: s0.sessionId, entityType: "Product", entityId: p.id, operation: "SAVE_PRODUCT", payload: { ...p }, idempotencyKey: buildIdempotencyKey(bid, s0.sessionId, `${p.id}:delete:undo-restore`, "SAVE_PRODUCT"), scanEventId: null }),
          );
        }
        for (const c of backup.counts) {
          if (c.quantity <= 0) continue; // the delete transferred nothing for zero rows -> nothing to reverse
          const live = liveCountById.get(c.id);
          if (live && live.productId !== c.productId) {
            // The row is still repointed at the provisional: pull the transferred units back off it.
            // Post-delete scans incremented the SAME remote row, so subtracting exactly the backup's
            // quantity leaves any residual units on the provisional (matches the local carve below).
            const outKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-undo-out`, "INCREMENT_COUNT");
            const outPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: live.productId, scanEventId: `${c.id}:delete-transfer-undo`, quantityDelta: -c.quantity, idempotencyKey: outKey };
            syncOps.push(
              makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: outPayload, idempotencyKey: outKey, scanEventId: null }),
            );
          }
          const inKey = buildIdempotencyKey(bid, c.sessionId, `${c.id}:delete-transfer-undo-in`, "INCREMENT_COUNT");
          const inPayload: IncrementPayload = { businessId: bid, sessionId: c.sessionId, productId: c.productId, scanEventId: `${c.id}:delete-transfer-undo`, quantityDelta: c.quantity, idempotencyKey: inKey };
          syncOps.push(
            makeQueueItem({ idFactory, now, businessId: bid, sessionId: c.sessionId, entityType: "InventoryCount", entityId: c.id, operation: "INCREMENT_COUNT", payload: inPayload, idempotencyKey: inKey, scanEventId: null }),
          );
        }
        set((s) => {
          // The repointed count rows share ids with the backed-up originals, so upsertById below
          // restores them onto the original product. LAW GUARD: a scan made AFTER the delete
          // incremented the SAME repointed row (Phase-2 re-scan bridge), so a plain restore would
          // absorb that unit - carve the surplus (quantity + event ids beyond the backup's) onto a
          // residual row that stays on the provisional. Total quantity is invariant across undo.
          const backupCountById = new Map(backup.counts.map((c) => [c.id, c]));
          const residuals: InventoryCount[] = [];
          for (const live of s.finalCounts) {
            const orig = backupCountById.get(live.id);
            if (!orig || live.quantity <= orig.quantity) continue;
            residuals.push({
              ...live,
              id: idFactory(),
              quantity: live.quantity - orig.quantity,
              scanEventIds: live.scanEventIds.filter((id) => !orig.scanEventIds.includes(id)),
              appliedIdempotencyKeys: live.appliedIdempotencyKeys.filter((k) => !orig.appliedIdempotencyKeys.includes(k)),
            });
          }
          const restoredCounts = [...upsertById(s.finalCounts, backup.counts), ...residuals];
          const stillCounted = new Set(restoredCounts.map((c) => c.productId));
          const minted = new Set(backup.mintedProvisionalIds ?? []);
          return {
          products: upsertById(s.products, backup.products).filter((p) => !(minted.has(p.id) && !stillCounted.has(p.id))),
          aliases: upsertById(s.aliases, backup.aliases),
          finalCounts: restoredCounts,
          catalog: [...s.catalog, ...backup.catalog.filter((c) => !s.catalog.some((x) => x.normalizedBarcode === c.normalizedBarcode && x.name === c.name))],
          shopOverrides: [...s.shopOverrides, ...backup.shopOverrides.filter((o) => !s.shopOverrides.some((x) => x.businessId === o.businessId && x.normalizedBarcode === o.normalizedBarcode))],
          scanFeed: s.scanFeed.map((e) => feedById.get(e.id) ?? e),
          lastProductDeleteBackup: null,
          };
        });
        // A minted provisional the undo just removed locally (no residual count kept it) must be
        // archived remotely too, or refreshFromCloud re-adds it as an active ghost product.
        for (const prov of mintedProducts) {
          if (get().products.some((p) => p.id === prov.id)) continue; // residual kept it -> keep remotely
          const archivedProv: Product = { ...prov, status: "archived", verified: false, updatedBy: "human" };
          syncOps.push(
            makeQueueItem({ idFactory, now, businessId: bid, sessionId: s0.sessionId, entityType: "Product", entityId: prov.id, operation: "SAVE_PRODUCT", payload: archivedProv, idempotencyKey: buildIdempotencyKey(bid, s0.sessionId, `${prov.id}:provisional:undo-archive`, "SAVE_PRODUCT"), scanEventId: null }),
          );
        }
        set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, ...syncOps] }));
        get().syncPending(); // drain the compensating ops now (same pattern as the delete)
        for (const p of backup.products) emitAudit({ entityType: "Product", entityId: p.id, action: "product_delete_undone", metadata: { name: p.name } });
        get().recordFeedback("restored_cleanup", { code: "", meta: { restored: restoredProductIds.size } });
        return true;
      },

      // P2 maintenance: backfill identifier fields from a "UPC <code> - " name prefix so legacy products
      // carry their barcode in a real field (not just the name). Reversible + audited; never auto-run.
      previewIdentifierBackfill: () => {
        const out: Array<{ productId: string; name: string; code: string }> = [];
        for (const p of get().products) {
          if (p.status === "archived" || p.primaryBarcode) continue; // only fill empty identifier rows
          const code = codeFromNamePrefix(p.name);
          if (code) out.push({ productId: p.id, name: p.name, code });
        }
        return out;
      },

      applyIdentifierBackfill: (productIds) => {
        const targets = new Set(productIds);
        const snapshot: Array<{ productId: string; primaryBarcode: string; upc: string }> = [];
        let changed = 0;
        const products = get().products.map((p) => {
          if (!targets.has(p.id) || p.status === "archived" || p.primaryBarcode) return p;
          const code = codeFromNamePrefix(p.name);
          if (!code) return p;
          const norm = normCodeToken(code);
          snapshot.push({ productId: p.id, primaryBarcode: p.primaryBarcode ?? "", upc: p.upc ?? "" });
          changed++;
          emitAudit({ entityType: "Product", entityId: p.id, action: "identifier_backfilled", metadata: { code: norm } });
          // Fill primaryBarcode; fill upc only when the code is a 12-digit UPC-A (don't mislabel other lengths).
          return { ...p, primaryBarcode: code, upc: !p.upc && /^\d{12}$/.test(norm) ? code : p.upc, updatedAt: now(), updatedBy: "human" };
        });
        if (changed > 0) set({ products, lastIdentifierBackfill: snapshot });
        return { changed };
      },

      undoIdentifierBackfill: () => {
        const snap = get().lastIdentifierBackfill;
        if (!snap || snap.length === 0) return false;
        const byId = new Map(snap.map((s) => [s.productId, s]));
        const products = get().products.map((p) => {
          const prev = byId.get(p.id);
          return prev ? { ...p, primaryBarcode: prev.primaryBarcode, upc: prev.upc, updatedAt: now(), updatedBy: "human" } : p;
        });
        set({ products, lastIdentifierBackfill: null });
        return true;
      },
  };
}
