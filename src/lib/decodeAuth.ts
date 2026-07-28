"use client";

import { getSession } from "@/lib/auth";
import { isLiveAuth } from "@/services/auth/authMode";
import { getSelectedBusinessId } from "@/lib/selectedBusiness";

// D4-follow-up (owner-confirmed live prod bug 2026-07-25/26): src/app/api/ai-lookup/route.ts's
// live-auth gate (lines ~294-324) requires body.idToken + body.businessId whenever isLiveAuth() &&
// !e2eMode(); a missing/empty idToken 401s with reasonCode "unauthenticated". scanStore's decode
// POST call sites never attached these fields, so every live-auth decode 401'd. This helper is the
// single place every call site resolves them from, using the SAME mechanism as the already-working
// import/report/settings call sites (getSession().getIdToken() + getSelectedBusinessId()).
//
// Contract: NEVER throws. In mock mode (isLiveAuth() false) it returns {} without even touching
// Firebase. Logged-out, no-selected-business, or any getSession/getIdToken failure all degrade to
// {} (or a partial object) rather than blocking the decode call - decode must keep working in mock
// mode and must fail via the route's own 401 (with its honest reasonCode), never via a client throw.
export async function authFieldsForDecode(): Promise<{ idToken?: string; businessId?: string }> {
  if (!isLiveAuth()) return {};
  try {
    const user = await getSession();
    if (!user) return {};
    const idToken = await user.getIdToken();
    const businessId = getSelectedBusinessId();
    return {
      ...(idToken ? { idToken } : {}),
      ...(businessId ? { businessId } : {}),
    };
  } catch {
    return {};
  }
}
