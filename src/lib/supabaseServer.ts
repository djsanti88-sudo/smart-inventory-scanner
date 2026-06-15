import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/services/db/database.types";

// SERVER-ONLY Supabase client holding the service-role key. The `server-only` import makes a build fail
// if this module is ever pulled into a client bundle. NEVER expose SUPABASE_SERVICE_ROLE_KEY to the
// client or via a NEXT_PUBLIC_ var (enforced by keySafety.test.ts). Use this only in server code
// (route handlers, server actions) for privileged operations - it BYPASSES Row-Level Security.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Service-role client (bypasses RLS). Server-side only. Throws if env is missing. */
export function getSupabaseServiceClient(): SupabaseClient<Database> {
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase service client not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side).",
    );
  }
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
