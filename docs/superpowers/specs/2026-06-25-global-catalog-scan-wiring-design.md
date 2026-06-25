# Global Catalog → Live Scan Resolution Wiring — Design

Date: 2026-06-25
Status: Approved (brainstorm) — pending implementation + proof

## Problem
The 52,359-entry global catalog (`catalogEntries`) is deployed and queryable, but the live
scan resolver **does not read it**. `processScan` only checks the in-memory `catalog` array
(populated from local/learned data + localStorage). `catalogRepository.getByBarcode()` exists
but has **no caller**. So scanned tires do not currently resolve from the 52k.

## Goal
Make the global cloud catalog the **primary identity source** for any code a shop hasn't
personally saved, while a shop's **own product keeps ownership/counting** (no duplicates).

## Resolution precedence (after change)
1. **Shop's own approved alias / verified product** (local deterministic resolver) → count into THEIR product. *(unchanged — protects counting; owner's deliberate data wins)*
2. **Shop override** → resolve.
3. **In-memory catalog** (already cached/learned this session) → verified hit resolves.
4. **🌐 Cloud global catalog** — `catalogRepository.getByBarcode(normalizedCandidate)` → a
   `verificationStatus === "verified"` hit resolves as "found from catalog"; cache the entry
   into the in-memory `catalog` so repeat scans are instant. *(NEW — this is the wiring)*
5. **AI** — only if the cloud catalog misses.

"Global first" = global is the identity source for everything in steps 3–5; only a shop's own
saved item (step 1–2) outranks it, per the owner's decision (count into their product).

## Mechanics
- The cloud lookup is **async** (Firestore round-trip), so it runs in `processScan`'s async
  post-resolution phase (same place AI runs today): the scan event is created `needs_review`
  instantly, then upgraded to `known`/counted when a verified cloud hit returns — mirroring the
  existing AI-upgrade path.
- Try the scan's `normalizedCandidates` against `getByBarcode` (first verified hit wins).
- **Safety:** the Phase-8C identity-context firewall still runs on a cloud hit — a poisoned/
  conflicting identity routes to Needs Review, never auto-counts.
- **Offline:** cloud lookup is skipped when offline → falls through to AI/Needs-Review (no regression).
- Only fires for codes the shop doesn't own → no extra latency on a shop's own products.

## Out of scope (YAGNI)
- Preloading/IndexedDB caching the 52k (Option 3) — add later only if scan latency hurts.
- Changing shop-owned-vs-global ownership (shop's own product still counts into theirs).

## Testing & proof
1. **Unit tests** (vitest): cloud verified hit resolves + counts "found from catalog" with no AI;
   cloud miss → AI path; firewall routes a poisoned cloud identity to review; a shop-owned code
   still counts into the shop's product (not the global identity); offline skips cloud → review.
2. **20-scan behavior test** (pre-deploy): run the resolution path against the LIVE cloud catalog
   with 20 barcodes (mix: tires in the 52k, one shop-owned code, one unknown) and observe each
   outcome. Decision gate before going further.
3. **Human-Bot proof** (`npm run qa:bots`): browser-scan a tire → "found from catalog" + screenshot.
4. **Production deploy** (Vercel): separate, explicitly gated on owner approval.

## Acceptance criteria
- 20-scan test: tires in the 52k resolve "found from catalog" from the cloud; the shop-owned
  code counts into the shop's product; the unknown falls to AI/Needs-Review.
- No wrong-identity auto-counts (firewall holds).
- Full vitest + tsc + lint green; bot proof screenshot captured.
