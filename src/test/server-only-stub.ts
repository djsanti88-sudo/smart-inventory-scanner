// Test-only no-op stub for the `server-only` package. Next.js maps `server-only` to a module that throws
// when imported from a client bundle; under vitest (no Next bundler) the real package throws unconditionally,
// so we alias it to this no-op (see vitest.config.ts) to unit-test server-only modules. The REAL server-only
// boundary is still enforced in the app build + by the static import-boundary test (no client file may import
// src/server/tire-knowledge/*).
export {};
