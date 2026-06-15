"use client";

import type { Session } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabaseClient";
import { isAuthBypassEnabled } from "@/services/auth/authBypass";
import type { Database } from "@/services/db/database.types";

// Supabase Auth for the launch MVP. Replaces the old localStorage mock. The service-role key is NEVER
// used here (client). See supabaseServer.ts for privileged server-side ops. The guarded E2E/test bypass
// (isAuthBypassEnabled) keeps Playwright specs green and is impossible in production.

export { isAuthBypassEnabled };
export type Membership = Database["public"]["Tables"]["memberships"]["Row"];
export type AppRole = "admin" | "counter";

export async function getSession(): Promise<Session | null> {
  if (isAuthBypassEnabled()) return { user: { id: "e2e-user" } } as unknown as Session;
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session;
}

export function onAuthChange(cb: (session: Session | null) => void): () => void {
  if (isAuthBypassEnabled()) return () => {};
  const { data } = getSupabaseBrowserClient().auth.onAuthStateChange((_e, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

export async function signInWithPassword(email: string, password: string) {
  return getSupabaseBrowserClient().auth.signInWithPassword({ email, password });
}

export async function signUp(email: string, password: string) {
  return getSupabaseBrowserClient().auth.signUp({ email, password });
}

export async function signOut(): Promise<void> {
  if (isAuthBypassEnabled()) return;
  await getSupabaseBrowserClient().auth.signOut();
}

/** Create a business and become its first admin (atomic, hardened SECURITY DEFINER RPC). */
export async function createBusiness(name: string): Promise<{ businessId: string | null; error: string | null }> {
  const { data, error } = await getSupabaseBrowserClient().rpc("create_business", { p_name: name });
  return { businessId: (data as string) ?? null, error: error?.message ?? null };
}

/** The signed-in user's memberships (RLS scopes this to their own businesses). */
export async function listMemberships(): Promise<Membership[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("memberships")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return [];
  return data ?? [];
}
