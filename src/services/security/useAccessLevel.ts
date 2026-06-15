"use client";

import { useScanStore } from "@/stores/scanStore";
import { effectiveClientAccessLevel, type AccessLevel } from "@/services/security/roleAccess";

// Client UI hint: is the signed-in user the platformOwner (full internal view) or a customer (product-
// facing only)? Source of truth for DATA access is server-side; this only gates what the UI renders.
// platformOwner is the PLATFORM allowlist (NEXT_PUBLIC_PLATFORM_OWNER_*), never a business role.
export function useAccessLevel(): AccessLevel {
  const userId = useScanStore((s) => s.userId);
  // Single source of truth (shared with the store persist split): honors the legacy-mock E2E override,
  // else maps the signed-in uid against the client platformOwner allowlist.
  return effectiveClientAccessLevel({ uid: userId });
}

export function useIsPlatformOwner(): boolean {
  return useAccessLevel() === "platform";
}
