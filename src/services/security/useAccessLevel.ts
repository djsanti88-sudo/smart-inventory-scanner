"use client";

import { useScanStore } from "@/stores/scanStore";
import { accessLevelClient, type AccessLevel } from "@/services/security/roleAccess";

// Client UI hint: is the signed-in user the platformOwner (full internal view) or a customer (product-
// facing only)? Source of truth for DATA access is server-side; this only gates what the UI renders.
// platformOwner is the PLATFORM allowlist (NEXT_PUBLIC_PLATFORM_OWNER_*), never a business role.
export function useAccessLevel(): AccessLevel {
  const userId = useScanStore((s) => s.userId);
  // E2E override: the legacy mock E2E suite (playwright.config.ts) exercises the FULL platformOwner view,
  // so it sets NEXT_PUBLIC_E2E_PLATFORM_OWNER=1. The human-bot suite does NOT set it (stays customer view
  // so SecurityLeakBot can verify hiding). Real cloud ignores this and uses the actual allowlist.
  if (process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER === "1") return "platform";
  return accessLevelClient({ uid: userId });
}

export function useIsPlatformOwner(): boolean {
  return useAccessLevel() === "platform";
}
