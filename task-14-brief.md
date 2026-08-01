# Task 14 authoritative acceptance contract

This tracked brief is the final evidence and acceptance contract for the exact 5,000-row local identity performance task. It contains no live data or secrets.

- Use one frozen deterministic synthetic fixture with exactly 5,000 rows. Verify its runtime SHA-256 and exact row/quantity bucket vector before timing.
- Record cold diagnostics separately. Warm crypto, parser, engine, and signer, then execute one warmup plus three measured warm runs and report the median. Record OS release, CPU, Node runtime, logical concurrency, fixture/snapshot hashes, procedure, and timestamp.
- Compare fresh comparable-machine warm median to the checked baseline with a maximum 1.10 ratio, while also enforcing warm preview wall <=10 seconds and nearest-rank sequential decision p95 <=2 ms. Environment mismatches are diagnostic and cannot be silently treated as portable proof.
- Decision timing performs exactly one real batched `lookupBatch`, constructs per-row snapshots from `candidatesByRecord`, then calls `decideIdentity` sequentially. It does not divide batch wall, use concurrent decision promises, or issue repeated one-row lookups.
- Exercise the real local all-hit source, `createIdentityPreview`, signed serialization, and `verifySignedPreviewChunks`. Verify actual post-sign UTF-8 sizes: multiple natural chunks, each <=524,288 bytes, aggregate <=32 MiB, and exactly 5,000 verified rows, decisions, and row IDs with matching recomputed root.
- Bind five terminal buckets with exact rows and quantities: automatic 1,000/1,000; review 1,000/2,000; abstain 1,000/3,000; non-product 1,000/4,000; invalid 1,000/5,000. Quantity accounting is derived from verified signed rows paired with their terminal decisions.
- Include exported `buildLocalIdentityPreviewRequest` shaping cost and preserve all 5,000 physical source rows in source order. Browser shaping and `buildImportPreview` bucket accounting remain one-pass.
- Local/mock preview input is separately bounded to 32 MiB. Signed output and apply-route limits remain unchanged. Prove a >512 KiB 5,000-row request delegates once; declared >32 MiB rejects before reading/delegation; missing or false-under-limit `Content-Length` streamed overflow rejects with zero delegation.
- Reader limits are 25 MiB, 64 sheets, 256 columns, and exactly 8,192 physical non-empty rows before inference, followed by at most 5,000 returned data rows across sheets. Exactly 5,000 succeeds; 5,001 rejects.
- Non-E2E DOM proof uploads through the real Task 12 shaper and a fetch stub invoking injected `createIdentityPreviewRoute`. The service receives 5,000 ordered rows, the panel reports all five buckets totaling 5,000, and realistic signed chunks pass through real validation/rendering.
- DOM remains bounded and aggregate-only. Malformed, inconsistent, incomplete, or oversized chunks keep Apply unavailable. Do not claim a server pagination API that does not exist.
- The offline benchmark executes current measurements and emits stable JSON or Markdown. Baseline writing is explicit-only; ordinary tests and comparisons never rewrite it.
- Architecture documents stateless signed chunks and reconcile-versus-count separation.
- Browser main-thread long-task proof is **BLOCKED** because E2E/Playwright is owner-forbidden. Node scheduling is not browser responsiveness proof.
- Poison dependencies must prove no provider, decode, external fetch, or storage write in the benchmark and injected preview route. Default composition purity remains Task 13 scope.

Required local gates: focused identity/import/DOM tests, ledger, corpus drift, golden baseline, focused ESLint, `npx tsc --noEmit --incremental false`, and `npm run build`. No E2E, Playwright, QA bots, live/provider calls, production operations, deploy, or push. Preserve `decode-outcomes/`.
