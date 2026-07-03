# Grounding Ladder + Verification Model — Design Spec

**Status:** Design locked with owner 2026-07-01. NOT yet an executable plan — see "Dependencies & sequencing" and "Recon required before Plan D."

**Goal:** Identify a scanned barcode as cheaply and quickly as possible, paying for AI only on the rare codes nothing free can crack, and never leaving a row empty — while every scan has already been counted the instant it was captured (Plan A), so all of this runs in the background and the user never waits.

## Core principles (owner-approved)

1. **Count first, identify later.** Plan A counts every scan synchronously. The whole ladder runs in the BACKGROUND and only upgrades the label/status. Speed of the ladder never blocks the count.
2. **Cheapest + fastest + highest-hit first; stop on a confident hit; pay only when free fails; pay premium only when cheap-pay fails; never dead-end.**
3. **One verify gate, not two (owner decision):** a resolution is **Verified** when the app itself confirms the **exact scanned code physically appears on a fetched page**. No separate trusted-allowlist requirement. Domain quality only affects *which* pages we open first (ranking), not the verify decision.
4. **Prefix DB is guidance + floor, never a blocker.** It never sends anything to review and never blocks a count. It is consulted only as the terminal fallback (below), split into a cheap early half and a brand-only floor.
5. **Cache every win back into the database.** A code is expensive at most ONCE; the next scan of it is a free Tier-1 hit forever. This is the dominant long-term cost saver.
6. **No "Needs Review" as a wall.** Two visible states only: **Verified** (app-confirmed) and **Suggested** (everything else, including the prefix floor). Everything counts.

## The ladder (locked order)

Statuses: **Verified** = app-confirmed exact code on a page. **Suggested** = weak / brand-only / unconfirmed. Both count.

**Tier 0 — Instant count (Plan A).** Every scan counts as a provisional row immediately. Everything below is background enrichment.

**Tier 1 — Own database (free, milliseconds).**
- 1a. Exact barcode lookup in Turso (76K tires + 4M retail). Hit → **Verified**, $0.
- 1b. **(Owner chose "A": promote the prefix's cheap half.)** Prefix → brand, then a **free brand + product-number DB re-lookup**. Catches products we own under a different/related number without touching web or AI. Hit → Verified/Suggested by match strength.

**Tier 2 — Free self-grounded web (free, ~1-3s, background).**
- 2a. Web search for the exact code. **Default engine: a scrape-friendly one (Bing or DuckDuckGo HTML)** because Google captchas scrapers; real Google only via the Sandbox browser if needed. (Owner decision.)
- 2b. Open the **top 2-3 best results in parallel** (parallel for speed); rank legit domains (manufacturer / retailer / GS1) above SEO-aggregator spam.
- 2c. **App confirms the exact code is on a fetched page** (free string match) → **Verified** (this is the single gate).
- 2d. If the page has the product but the name needs cleaning, hand the fetched page text to **Gemini Flash / ChatGPT mini** — cheap tokens, **NO paid grounding tool** (Playwright already did the grounding). Owner's key insight: the expensive part of Gemini is the grounding, not Flash; self-retrieve, then cheap-extract.

**Tier 3 — Premium "big boys" (paid, rare — only if Tier 2 finds nothing).**
- The "Google didn't have it but ChatGPT found it in seconds" case. Escalate to a **premium model with its own browsing/deep search**, **sequential**: Gemini (Pro/grounded) first, **ChatGPT mini / GPT premium only on a Gemini miss** — never parallel, never on everything. (Matches existing Gemini-first / OpenAI-escalation baseline.)
- Honesty note recorded for the owner: the app calls the paid API per request; it cannot ride a human's ChatGPT subscription. This tier is real money, so it is gated to only the codes nothing else cracked.

**Tier 4 — Prefix floor (free, terminal, never empty).**
- 4a. Prefix → **brand** (stated with confidence — the company prefix reliably identifies the company).
- 4b. Brand + item-reference digits → last attempt to name the specific product (brand-scoped). Found → **Suggested** "Brand [product]".
- 4c. Else → **"Michelin / product unconfirmed"** — brand certain, product unknown. Suggested. Never a blank row.

## Verification Gate (execution rule for the eventual Plan D, same as Plan A)

Every task is proven in the real running app with Playwright before advancing; if a gate fails, loop with `superpowers:systematic-debugging` and fix before the next task; never advance while red. (Full text lives in the Plan A doc's "Verification Gate" section and is inherited by every plan.)

## Dependencies & sequencing

This ladder is **Plan D**. It cannot be built first:
- **Plan A** (count decouple + breaker) — DONE as a written plan; makes "scan N = count N" true and gives Tier 0.
- **Plan B** (Turso lookup wired + data loaded) — provides Tiers 1a/1b. The single biggest cost win (known codes stop hitting AI).
- **Plan C** (Verified/Suggested model; retire "Needs Review" as a wall; prefix demoted to guidance/floor) — provides the status model Tiers 1-4 write into.
- **Plan D** (this ladder: self-grounded web + cheap extract + premium escalation + cache) — depends on B and C.

Recommended build order: **A → B → C → D.**

## Recon required before Plan D can be written as real, no-placeholder code

Do NOT write Plan D's implementation steps until these are read/verified (writing them blind would fabricate internals — forbidden by writing-plans and the owner doctrine):
- `src/app/api/ai-lookup/route.ts` — current Gemini/OpenAI call structure, grounding usage, modes (`decode` / `decode-deep`).
- `src/services/ai/decodeOrchestrator.ts`, `evidenceVerifier.ts`, `pageFetch.ts`, `decodeFallback.ts`, `firecrawlProvider.ts` — existing grounding/evidence machinery to reuse vs replace.
- Turso repo + schema (`catalogRepository`, retail catalog) — how a brand-scoped / number lookup (Tier 1b) and cache-write-back would work.
- Vercel Sandbox feasibility for headless Playwright (does not exist yet) + a scrape-friendly search approach that survives bot-blocking.
- Current Gemini grounding pricing (confirm the real savings; recalled, not yet verified).

## Out of scope (YAGNI)

- No paid barcode APIs, no managed browser services (owner: free stack only; Gemini/OpenAI paid tiers are the sole paid path, kept rare).
- No maintained trusted-site allowlist as a hard verify gate (owner chose the single "code-on-page" gate).
- No prefix double-check on a grounding success (owner: grounding wins, full stop).
