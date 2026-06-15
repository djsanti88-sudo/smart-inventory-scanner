import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { productRepository, aliasRepository } from "@/services/db/repositories";

// Light proof that the typed repositories work end-to-end against the live local stack as a normal
// authenticated user (RLS-aware). Skips without the local Supabase env (keeps `npm test` green).

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ready = Boolean(URL && ANON && SERVICE);
const PW = "repo-test-password-123!";

describe.skipIf(!ready)("typed repositories (authenticated round-trip)", () => {
  const admin = ready ? createClient(URL, SERVICE, { auth: { persistSession: false } }) : (null as unknown as SupabaseClient);
  const email = `repo-${randomUUID()}@test.local`;
  let userId = "";
  let client: SupabaseClient;
  let businessId = "";

  beforeAll(async () => {
    const u = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true });
    if (u.error) throw u.error;
    userId = u.data.user!.id;
    client = createClient(URL, ANON, { auth: { persistSession: false } });
    const s = await client.auth.signInWithPassword({ email, password: PW });
    if (s.error) throw s.error;
    const rpc = await client.rpc("create_business", { p_name: "Repo Test Co" });
    if (rpc.error) throw rpc.error;
    businessId = rpc.data as string;
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    if (businessId) await admin.from("businesses").delete().eq("id", businessId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("productRepository upserts + lists + finds by barcode", async () => {
    const products = productRepository(client);
    const created = await products.upsert({ business_id: businessId, name: "Repo Widget", primary_barcode: "012345678905", verified: true });
    expect(created.id).toBeTruthy();
    const list = await products.listByBusiness(businessId);
    expect(list.map((p) => p.name)).toContain("Repo Widget");
    const byCode = await products.findByBarcode(businessId, "012345678905");
    expect(byCode).toHaveLength(1);

    // aliasRepository upsert + approve
    const aliases = aliasRepository(client);
    const alias = await aliases.upsert({ business_id: businessId, product_id: created.id, clean_code: "012345678905", approved: false });
    await aliases.setApproved(alias.id, true);
    const approved = await aliases.listApproved(businessId);
    expect(approved.map((a) => a.id)).toContain(alias.id);
  });
});
