"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";
import { runSignOutFlow } from "@/authentication/service/signOutFlow";
import { isLiveAuth } from "@/authentication/service/authMode";

// App navigation. Shows an open-review count badge so unknown codes are obvious but not disruptive.
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const openReviews = useScanStore((s) => s.needsReviewQueue.filter((r) => r.status === "open").length);

  const links = [
    { href: "/scan", label: "Scan" },
    { href: "/history", label: "History" },
    { href: "/products", label: "Products" },
    { href: "/review", label: "Review", badge: openReviews },
    { href: "/reconcile", label: "Reconcile" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <header className="border-b border-zinc-200 bg-white">
      <nav className="mx-auto flex max-w-7xl items-center gap-1 px-4 py-2">
        <span className="mr-6 flex items-center gap-2 text-lg font-bold tracking-tight text-zinc-900">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-blue-600" aria-hidden="true">
            <path fillRule="evenodd" d="M4.5 2A2.5 2.5 0 002 4.5v2a.5.5 0 001 0v-2A1.5 1.5 0 014.5 3h2a.5.5 0 000-1h-2zm9 0a.5.5 0 000 1h2A1.5 1.5 0 0117 4.5v2a.5.5 0 001 0v-2A2.5 2.5 0 0015.5 2h-2zM3 13.5a.5.5 0 00-1 0v2A2.5 2.5 0 004.5 18h2a.5.5 0 000-1h-2A1.5 1.5 0 013 15.5v-2zm14 0a.5.5 0 011 0v2a2.5 2.5 0 01-2.5 2.5h-2a.5.5 0 010-1h2a1.5 1.5 0 001.5-1.5v-2zM5 7.5a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm-6 3a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5z" clipRule="evenodd"/>
          </svg>
          Smart Inventory
        </span>
        {links.map((l) => {
          const active = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`relative inline-flex min-h-[44px] items-center rounded-lg px-3 text-base font-medium ${
                active ? "bg-blue-50 text-blue-700" : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {l.label}
              {typeof l.badge === "number" && l.badge > 0 && (
                <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">
                  {l.badge}
                </span>
              )}
            </Link>
          );
        })}
        {isLiveAuth() && (
          <button
            type="button"
            // F1/C1: the ONE shared sign-out flow (honest unsynced warning + full tenant wipe + signOut +
            // redirect). Settings' Sign out button calls the same helper so the two can never drift.
            onClick={() => void runSignOutFlow(() => router.replace("/login"))}
            className="ml-auto inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Log out
          </button>
        )}

      </nav>
    </header>
  );
}
