"use client";

import { useScanStore } from "@/stores/scanStore";
import { accessLevelClient, type AccessLevel } from "@/services/security/roleAccess";

// Client UI hint: is the signed-in user the platformOwner (full internal view) or a customer (product-
// facing only)? Source of truth for DATA access is server-side; this only gates what the UI renders.
// platformOwner is the PLATFORM allowlist (NEXT_PUBLIC_PLATFORM_OWNER_*), never a business role.
export function useAccessLevel(): AccessLevel {
  const userId = useScanStore((s) => s.userId);
  return accessLevelClient({ uid: userId });
}

export function useIsPlatformOwner(): boolean {
  return useAccessLevel() === "platform";
}
