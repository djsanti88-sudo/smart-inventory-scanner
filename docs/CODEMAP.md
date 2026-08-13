# CODEMAP - reviewing this project by section

Created 2026-08-12. Source of truth for the section list is `codemap.json`;
run `npm run check:section` to list sections, `npm run check:section <id>` to
print one, `--gates` to run its gate commands.

## Why sections are not folders

The natural instinct is to reorganize `src/` into feature folders so the project
reads as parts rather than one mass. **Do not do that here.** Three reasons, in
increasing order of importance.

**1. The current top-level layout already carries meaning, and it is a security
boundary, not a filing preference.**

| directory | contract |
|---|---|
| `src/server/**` | server-only. Holds secrets, native modules, the corpus DBs. Must never enter a client bundle. |
| `src/services/**` | pure and client-safe. No React, no `next/*`. |
| `src/stores/**` | client state (Zustand). |
| `src/components/**`, `src/app/**` | client UI and routes. |

A feature folder like `src/features/decode/` would put server-only provider code
and client UI in the same tree. The boundary that keeps API keys out of the
browser would then depend on discipline instead of location.

**2. Paths are load-bearing in the build and test config.** `vitest.config.ts`
carries 13 path globs across its `unit` / `dom` projects and its exclude list,
`next.config.ts` pins `serverExternalPackages`, `scripts/proof-all.mjs` names
suite files directly, and `tsconfig` maps `@/`.

**3. The decisive one: a reorg would silently disarm the guards, not break them.**
Several security tests locate their targets BY PATH:

```js
// src/services/keySafety.transitive.test.ts - finds client entry points
if (/[\\/](components|stores)[\\/]/.test(f)) return true;

// src/server/upc/importBoundary.test.ts - same shape
if (!/[\\/](stores|components)[\\/]/.test(f)) continue;
```

Move `src/stores` to `src/features/scan/state/` and those regexes stop matching.
The tests do not fail. They **pass, having checked nothing** - the key-safety and
server-only boundary guards quietly become no-ops. That is exactly the
"stated but not enforced" defect class the 2026-08-12 audit existed to remove
(see `LESSONS_LEARNED.md` and the invariant-audit reports), and a reorg would
reintroduce it on the guards themselves.

Both files carry a coarse tripwire (`expect(files.length).toBeGreaterThan(50)`,
`expect(entries.length).toBeGreaterThan(20)`) which would catch a total collapse
but not a partial one. Treat them as smoke alarms, not seatbelts.

**What sections give you instead:** a name, a file set, the invariants that must
hold, the traps that have already caused wrong conclusions, and the exact gate
command - which is everything the folder layout was being asked to communicate,
with none of the risk. Handing a subagent `npm run check:section decode` is the
intended workflow.

## The sections

| id | owns | primary gates |
|---|---|---|
| `scan-core` | scan intake, count ledger, resolution, optimistic state, sync queue | `proof:all`, `test:ledger` |
| `decode` | the cost-ordered ladder, providers, evidence, daily cap and breaker | `proof:all`, route + pipeline suites |
| `ui` | client components, App Router pages, auth surface | `proof:all`, `test:e2e`, `qa:bots` |
| `data` | Firestore sync and tenancy, catalog, reconcile, CSV, the corpora | `proof:all`, `test:firebase`, corpus drift + golden |
| `tooling` | scripts, gates, docs | `proof:all` |

Full detail, including per-section invariants and traps, lives in `codemap.json`
and prints via `npm run check:section <id>`.

## Keeping it honest

- A section is stale the moment its globs stop matching reality. When you add a
  top-level area, add it to `codemap.json` in the same change.
- Gate commands in the map must be real npm scripts. A section whose gate does not
  run is worse than a section with no gate, because it reads as covered.
- `npm run proof:all` is the honest gate. `npm run proof:local` is blind to the
  `node:test` suites and to the 11 emulator-gated `*.rules.test.ts` files.

## The one restructuring worth doing

`src/services/` has 28 loose `.ts` files at its root beside 23 organized
subdirectories. Grouping those into topical subdirs (CSV and import/export, code
normalization, identity and dedup, the ledger) is contained, mechanical, verified
by `proof:all` at every step, and crosses no security boundary. That is real
sub-foldering where it actually helps. It is NOT started; it is the recommended
next structural step if the owner wants one.
