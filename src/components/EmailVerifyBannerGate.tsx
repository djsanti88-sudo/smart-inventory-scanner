"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { onAuthChange } from "@/lib/auth";
import { EmailVerifyBanner } from "./EmailVerifyBanner";

/** Client-side auth subscription for the server (app) layout. In mock mode there is no user,
 *  so this renders nothing (banner's null guard). */
export function EmailVerifyBannerGate() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthChange(setUser), []);
  return <EmailVerifyBanner user={user} />;
}
