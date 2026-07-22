// No-op stub for the `server-only` package, used ONLY by the corpus-purge CLI's tsconfig paths alias
// (corpus-purge.tsconfig.json). `server-only` throws outside a Next bundler; the purge lib guards
// itself with it, so the plain-Node CLI aliases it to this no-op. The real server-only boundary is
// still enforced by the app build + the static import-boundary tests.
export {};
