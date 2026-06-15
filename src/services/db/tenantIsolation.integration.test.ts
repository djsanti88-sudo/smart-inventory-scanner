import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

// REAL RLS proof (guardrail 2): the service role is used ONLY for setup/cleanup (creating + deleting test
// users). Every isolation ASSERTION runs as a NORMAL authenticated user client (anon key + a real signed-in
// session). Runs only when the local Supabase env is provided; otherwise SKIPS so `npm test` stays green
// without Docker. To run the proof:
//   SUPABASE_URL=http://127.0.0.1:55321 \
//   SUPABASE_ANON_KEY=<local anon> SUPABASE_SERVICE_ROLE_KEY=<local service> \
//   npx vitest run src/services/db/tenantIsolation.integration.test.ts

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ready = Boolean(URL && ANON && SERVICE);

const PW = "iso-test-password-123!";
const anonClient = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

describe.skipIf(!ready)("tenant isolation (RLS) - proven with authenticated user clients", () => {
  const admin = ready ? createClient(URL, SERVICE, { auth: { persistSession: false } }) : (null as unknown as SupabaseClient);
  const emailA = `iso-a-${randomUUID()}@test.local`;
  const emailB = `iso-b-${randomUUID()}@test.local`;
  let userAId = "";
  let userBId = "";
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let businessA = "";
  let businessB = "";
  let productAId = "";

  beforeAll(async () => {
    // --- setup with SERVICE ROLE (allowed only for setup): create two confirmed users ---
    const a = await admin.auth.admin.createUser({ email: emailA, password: PW, email_confirm: true });
    const b = await admin.auth.admin.createUser({ email: emailB, password: PW, email_confirm: true });
    if (a.error) throw a.error;
    if (b.error) throw b.error;
    userAId = a.data.user!.id;
    userBId = b.data.user!.id;

    // --- everything below runs as NORMAL authenticated users ---
    clientA = anonClient();
    clientB = anonClient();
    const signA = await clientA.auth.signInWithPassword({ email: emailA, password: PW });
    const signB = await clientB.auth.signInWithPassword({ email: emailB, password: PW });
    if (signA.error) throw signA.error;
    if (signB.error) throw signB.error;

    // each user creates their own business via the hardened RPC (becomes its admin)
    const rpcA = await clientA.rpc("create_business", { p_name: "Iso Test A" });
    const rpcB = await clientB.rpc("create_business", { p_name: "Iso Test B" });
    if (rpcA.error) throw rpcA.error;
    if (rpcB.error) throw rpcB.error;
    businessA = rpcA.data as string;
    businessB = rpcB.data as string;

    // user A inserts a product into business A (as themselves)
    const insA = await clientA.from("products").insert({ business_id: businessA, name: "A-Widget" }).select("id").single();
    if (insA.error) throw insA.error;
    productAId = insA.data!.id;
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    // cleanup with service role (allowed): cascade-delete businesses, then delete users
    if (businessA) await admin.from("businesses").delete().eq("id", businessA);
    if (businessB) await admin.from("businesses").delete().eq("id", businessB);
    if (userAId) await admin.auth.admin.deleteUser(userAId);
    if (userBId) await admin.auth.admin.deleteUser(userBId);
  });

  it("create_business made the creator an admin member of their own business", async () => {
    const { data, error } = await clientA.from("memberships").select("role,business_id").eq("business_id", businessA);
    expect(error).toBeNull();
    expect(data).toEqual([expect.objectContaining({ role: "admin", business_id: businessA })]);
  });

  it("(a) User A can READ and WRITE Business A data", async () => {
    const read = await clientA.from("products").select("*").eq("business_id", businessA);
    expect(read.error).toBeNull();
    expect((read.data ?? []).length).toBeGreaterThan(0);
    const write = await clientA.from("products").update({ brand: "OwnedByA" }).eq("id", productAId).select();
    expect(write.error).toBeNull();
    expect((write.data ?? []).length).toBe(1);
  });

  it("(b) User B CANNOT READ Business A rows", async () => {
    const filtered = await clientB.from("products").select("*").eq("business_id", businessA);
    expect(filtered.error).toBeNull();
    expect(filtered.data ?? []).toHaveLength(0);
    const all = await clientB.from("products").select("*");
    expect((all.data ?? []).some((r) => r.business_id === businessA)).toBe(false);
  });

  it("(c) User B CANNOT INSERT a row with a forged business_id = A (RLS WITH CHECK)", async () => {
    const res = await clientB.from("products").insert({ business_id: businessA, name: "forged-by-B" }).select();
    expect(res.error).toBeTruthy(); // new row violates row-level security policy
    expect(res.data ?? []).toHaveLength(0);
    // and A never sees a forged row
    const check = await clientA.from("products").select("id").eq("name", "forged-by-B");
    expect(check.data ?? []).toHaveLength(0);
  });

  it("(d) User B CANNOT UPDATE Business A rows", async () => {
    const res = await clientB.from("products").update({ name: "hacked-by-B" }).eq("id", productAId).select();
    expect(res.data ?? []).toHaveLength(0); // 0 rows affected (RLS USING hides them)
    const check = await clientA.from("products").select("name").eq("id", productAId).single();
    expect(check.data?.name).not.toBe("hacked-by-B");
  });

  it("(e) User B CANNOT DELETE Business A rows", async () => {
    const res = await clientB.from("products").delete().eq("id", productAId).select();
    expect(res.data ?? []).toHaveLength(0);
    const check = await clientA.from("products").select("id").eq("id", productAId).single();
    expect(check.data?.id).toBe(productAId); // still exists
  });
});
