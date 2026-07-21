import Link from "next/link";

// Custom 404 with the real app chrome. Any guessable/renamed URL (e.g. the very plausible
// /inventory, which is not a route - the real route is /products) must never strand a user on
// Next's bare stock 404 with no logo and no way back into the app (UX audit Critical #2).
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 p-4 text-center">
      <span className="flex items-center gap-2 text-lg font-bold tracking-tight text-zinc-900">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-blue-600" aria-hidden="true">
          <path fillRule="evenodd" d="M4.5 2A2.5 2.5 0 002 4.5v2a.5.5 0 001 0v-2A1.5 1.5 0 014.5 3h2a.5.5 0 000-1h-2zm9 0a.5.5 0 000 1h2A1.5 1.5 0 0117 4.5v2a.5.5 0 001 0v-2A2.5 2.5 0 0015.5 2h-2zM3 13.5a.5.5 0 00-1 0v2A2.5 2.5 0 004.5 18h2a.5.5 0 000-1h-2A1.5 1.5 0 013 15.5v-2zm14 0a.5.5 0 011 0v2a2.5 2.5 0 01-2.5 2.5h-2a.5.5 0 010-1h2a1.5 1.5 0 001.5-1.5v-2zM5 7.5a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm-6 3a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5zm3 0a.5.5 0 01.5-.5h1a.5.5 0 010 1h-1a.5.5 0 01-.5-.5z" clipRule="evenodd"/>
        </svg>
        Smart Inventory
      </span>
      <h1 className="text-2xl font-semibold text-zinc-900">Page not found</h1>
      <p className="max-w-sm text-base text-zinc-600">
        We could not find that page. It may have moved or the address may be mistyped.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/scan"
          className="inline-flex min-h-[44px] items-center rounded-lg bg-blue-600 px-4 text-base font-medium text-white hover:bg-blue-700"
        >
          Go to Scan
        </Link>
        <Link
          href="/products"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-zinc-300 px-4 text-base font-medium text-zinc-700 hover:bg-zinc-50"
        >
          Go to Products
        </Link>
      </div>
    </main>
  );
}
