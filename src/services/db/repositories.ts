import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/services/db/database.types";

// Typed repositories over Supabase. Dependency-injected client (browser, server, or a test client) so
// they are testable and RLS-aware (every call runs under the caller's session). These are the seam Phase
// 2 will wire the scan/count workflow onto; in Phase 1 they are created and lightly proven by an
// integration test. Idempotency is preserved by upsert-by-id (the app generates stable ids/keys).
//
// Repositories return DB row types (snake_case) as generated in database.types.ts. Phase 2 adds the
// camelCase domain mapping if needed.

type DB = Database;
type Tables = DB["public"]["Tables"];
export type ProductRow = Tables["products"]["Row"];
export type AliasRow = Tables["aliases"]["Row"];
export type ScanEventRow = Tables["scan_events"]["Row"];
export type InventoryCountRow = Tables["inventory_counts"]["Row"];
export type InventorySessionRow = Tables["inventory_sessions"]["Row"];
export type UnknownReviewRow = Tables["unknown_code_reviews"]["Row"];
export type MembershipRow = Tables["memberships"]["Row"];
export type BusinessRow = Tables["businesses"]["Row"];
export type SettingsRow = Tables["settings"]["Row"];
export type ShopOverrideRow = Tables["shop_overrides"]["Row"];

type Client = SupabaseClient<DB>;

export function productRepository(client: Client) {
  return {
    listByBusiness: async (businessId: string): Promise<ProductRow[]> => {
      const { data, error } = await client.from("products").select("*").eq("business_id", businessId);
      if (error) throw error;
      return data ?? [];
    },
    getById: async (id: string): Promise<ProductRow | null> => {
      const { data, error } = await client.from("products").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
    findByBarcode: async (businessId: string, code: string): Promise<ProductRow[]> => {
      const { data, error } = await client.from("products").select("*").eq("business_id", businessId).eq("primary_barcode", code);
      if (error) throw error;
      return data ?? [];
    },
    upsert: async (row: Tables["products"]["Insert"]): Promise<ProductRow> => {
      const { data, error } = await client.from("products").upsert(row).select().single();
      if (error) throw error;
      return data;
    },
    deleteById: async (id: string): Promise<void> => {
      const { error } = await client.from("products").delete().eq("id", id);
      if (error) throw error;
    },
  };
}

export function aliasRepository(client: Client) {
  return {
    listByBusiness: async (businessId: string): Promise<AliasRow[]> => {
      const { data, error } = await client.from("aliases").select("*").eq("business_id", businessId);
      if (error) throw error;
      return data ?? [];
    },
    listApproved: async (businessId: string): Promise<AliasRow[]> => {
      const { data, error } = await client.from("aliases").select("*").eq("business_id", businessId).eq("approved", true);
      if (error) throw error;
      return data ?? [];
    },
    upsert: async (row: Tables["aliases"]["Insert"]): Promise<AliasRow> => {
      const { data, error } = await client.from("aliases").upsert(row).select().single();
      if (error) throw error;
      return data;
    },
    setApproved: async (id: string, approved: boolean): Promise<void> => {
      const { error } = await client.from("aliases").update({ approved }).eq("id", id);
      if (error) throw error;
    },
  };
}

export function scanEventRepository(client: Client) {
  return {
    listByBusiness: async (businessId: string): Promise<ScanEventRow[]> => {
      const { data, error } = await client.from("scan_events").select("*").eq("business_id", businessId).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    // upsert by stable id -> retry-safe (re-applying the same scan event never duplicates).
    upsert: async (row: Tables["scan_events"]["Insert"]): Promise<ScanEventRow> => {
      const { data, error } = await client.from("scan_events").upsert(row).select().single();
      if (error) throw error;
      return data;
    },
  };
}

export function inventoryCountRepository(client: Client) {
  return {
    listBySession: async (businessId: string, sessionId: string): Promise<InventoryCountRow[]> => {
      const { data, error } = await client.from("inventory_counts").select("*").eq("business_id", businessId).eq("session_id", sessionId);
      if (error) throw error;
      return data ?? [];
    },
    upsert: async (row: Tables["inventory_counts"]["Insert"]): Promise<InventoryCountRow> => {
      const { data, error } = await client.from("inventory_counts").upsert(row, { onConflict: "business_id,session_id,product_id" }).select().single();
      if (error) throw error;
      return data;
    },
  };
}

export function inventorySessionRepository(client: Client) {
  return {
    listByBusiness: async (businessId: string): Promise<InventorySessionRow[]> => {
      const { data, error } = await client.from("inventory_sessions").select("*").eq("business_id", businessId).order("started_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    create: async (row: Tables["inventory_sessions"]["Insert"]): Promise<InventorySessionRow> => {
      const { data, error } = await client.from("inventory_sessions").insert(row).select().single();
      if (error) throw error;
      return data;
    },
    complete: async (id: string, completedAt: string): Promise<void> => {
      const { error } = await client.from("inventory_sessions").update({ status: "completed", completed_at: completedAt }).eq("id", id);
      if (error) throw error;
    },
  };
}

export function unknownReviewRepository(client: Client) {
  return {
    listOpen: async (businessId: string): Promise<UnknownReviewRow[]> => {
      const { data, error } = await client.from("unknown_code_reviews").select("*").eq("business_id", businessId).eq("status", "open");
      if (error) throw error;
      return data ?? [];
    },
    upsert: async (row: Tables["unknown_code_reviews"]["Insert"]): Promise<UnknownReviewRow> => {
      const { data, error } = await client.from("unknown_code_reviews").upsert(row).select().single();
      if (error) throw error;
      return data;
    },
  };
}

export function membershipRepository(client: Client) {
  return {
    listMine: async (): Promise<MembershipRow[]> => {
      const { data, error } = await client.from("memberships").select("*");
      if (error) throw error;
      return data ?? [];
    },
    listForBusiness: async (businessId: string): Promise<MembershipRow[]> => {
      const { data, error } = await client.from("memberships").select("*").eq("business_id", businessId);
      if (error) throw error;
      return data ?? [];
    },
    addMember: async (row: Tables["memberships"]["Insert"]): Promise<MembershipRow> => {
      const { data, error } = await client.from("memberships").insert(row).select().single();
      if (error) throw error;
      return data;
    },
  };
}

export function businessRepository(client: Client) {
  return {
    listMine: async (): Promise<BusinessRow[]> => {
      const { data, error } = await client.from("businesses").select("*");
      if (error) throw error;
      return data ?? [];
    },
    getById: async (id: string): Promise<BusinessRow | null> => {
      const { data, error } = await client.from("businesses").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
  };
}

export function settingsRepository(client: Client) {
  return {
    get: async (businessId: string): Promise<SettingsRow | null> => {
      const { data, error } = await client.from("settings").select("*").eq("business_id", businessId).maybeSingle();
      if (error) throw error;
      return data;
    },
    upsert: async (row: Tables["settings"]["Insert"]): Promise<SettingsRow> => {
      const { data, error } = await client.from("settings").upsert(row).select().single();
      if (error) throw error;
      return data;
    },
  };
}

export function shopOverrideRepository(client: Client) {
  return {
    listByBusiness: async (businessId: string): Promise<ShopOverrideRow[]> => {
      const { data, error } = await client.from("shop_overrides").select("*").eq("business_id", businessId);
      if (error) throw error;
      return data ?? [];
    },
    upsert: async (row: Tables["shop_overrides"]["Insert"]): Promise<ShopOverrideRow> => {
      const { data, error } = await client.from("shop_overrides").upsert(row, { onConflict: "business_id,normalized_barcode" }).select().single();
      if (error) throw error;
      return data;
    },
  };
}
