"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useScanStore } from "@/stores/scanStore";
import { signOut } from "@/lib/auth";

// App navigation. Shows an open-review count badge so unknown codes are obvious but not disruptive.
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const openReviews = useScanStore((s) => s.needsReviewQueue.filter((r) => r.status === "open").length);

  const links = [
    { href: "/scan", label: "Scan" },
    { href: "/products", label: "Products" },
    { href: "/review", label: "Needs Review", badge: openReviews },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <header className="border-b border-zinc-200 bg-white">
      <nav className="mx-auto flex max-w-7xl items-center gap-1 px-4 py-2">
        <span className="mr-4 text-base font-semibold text-zinc-900">Smart Inventory Scanner</span>
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
                <span className="ml-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-xs text-white">
                  {l.badge}
                </span>
              )}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm("Log out now? Your counts are saved - you can sign back in any time to keep going.")) return;
            await signOut();
            router.replace("/login");
          }}
          className="ml-auto inline-flex min-h-[44px] items-center rounded-lg px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Log out
        </button>
      </nav>
    </header>
  );
}
