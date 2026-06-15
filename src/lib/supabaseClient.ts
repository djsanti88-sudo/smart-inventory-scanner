"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/services/db/database.types";

// Browser Supabase client. Uses ONLY the public URL + anon (publishable) key - both are safe to ship to
// the client by design. The service-role key is NEVER imported here (see supabaseServer.ts; enforced by
// keySafety.test.ts).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cached: SupabaseClient<Database> | null = null;

/** Singleton browser client. Throws a clear error if the public env vars are missing. */
export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  if (cached) return cached;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  cached = createClient<Database>(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}
