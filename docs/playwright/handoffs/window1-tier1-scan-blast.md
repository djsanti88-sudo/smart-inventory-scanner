# Handoff: Window 1 - Tier 1 scan blast + "why do saved codes re-decode?" investigation

You are running the Tier 1 Playwright CLI drill for the Scanbin project. Read this whole file
before acting. Skill reference: `.claude/skills/playwright-cli/SKILL.md`.

## Mission

On the LIVE PRODUCTION site `https://inventory-lovat-six.vercel.app`, using the owner's OWN
Chrome (attached, never a new browser), do three things:

1. **Paste-all-at-once test**: paste the entire 124-code list (from
   `docs/playwright/handoffs/codes-124.txt`) into the scan bar in ONE paste and observe exactly
   what the app does with it.
2. **Scanner-speed one-by-one blast**: then scan the same codes one at a time (type + Enter,
   fast), and verify the TOP-LEVEL LAW: every code appears on the feed and counts. 124 in =
   124 counted, no exceptions.
3. **The real question - decode vs saved**: the owner has scanned these codes MANY times before
   and they always show a "decoding" behavior. They should already be saved (decode cache /
   learned tier / master DB). Find out, with network evidence, WHY re-scans still act like they
   are decoding. Is it (a) a real re-decode (cache miss - a defect), (b) a cache HIT that the UI
   still presents as "decoding" (cosmetic), or (c) expected because AI results are never saved
   as aliases (by design, resolver only trusts approved aliases) and the ladder re-runs but
   settles free on L1 cache?

## Hard constraints (owner orders)

- PRODUCTION site, owner's real Chrome profile (his Vercel toolbar login lives there).
- NEVER open a new Chrome instance. Attach to the running one (setup below). Work in your OWN
  new tab. Never `tab-close` or `tab-select` tabs you did not create.
- NEVER run `playwright-cli close` on an attached browser - that closes the owner's Chrome.
  End with `detach` only.
- Two other Claude windows share this same Chrome via their own sessions. Use ONLY your session
  name `-s=tier1scan` on every command. Don't touch their tabs.
- COST GUARD: production decode may hit GPT-5.4 mini. Expected result
  is free cache hits. After the first 10 one-by-one scans, inspect the network responses: if
  repeated GPT decodes are firing for previously-scanned codes, PAUSE the blast, capture evidence, and
  report - that IS the bug, don't pay for it 114 more times.
- Scans will add counts to the owner's real production local state. He knows and approves. Note
  in your report which session the counts landed in so he can clean up if he wants.

## Setup (owner must have done the one-time Chrome restart with --remote-debugging-port=9222)

```powershell
cd c:\Users\djsan\inventory
npx playwright-cli -s=tier1scan attach --cdp=http://localhost:9222
npx playwright-cli -s=tier1scan tab-new https://inventory-lovat-six.vercel.app
npx playwright-cli -s=tier1scan snapshot
```

If attach fails, STOP and tell the owner Chrome needs the debug-port restart (see
`docs/playwright/handoffs/README-chrome-attach.md`).

## Phase A - paste all at once

1. Snapshot, find the scan input (it is the dedicated scanner input, focused by default -
   `components/ScannerInput.tsx`, uncontrolled DOM input).
2. Read the full code list from `docs/playwright/handoffs/codes-124.txt`. Build the exact
   clipboard-style payload the owner would paste (codes separated by spaces/newlines as in the
   file) and put it into the input in ONE `fill` (this is the paste simulation), then press
   Enter once.
3. Screenshot + snapshot. Record exactly what happened: one giant garbage scan? Split into 124?
   Nothing? This is exploratory - whatever it does is the finding. If it created a junk row,
   verify the junk row still APPEARED AND COUNTED (that's the law), then note it for cleanup.

## Phase B - one-by-one blast

1. For each code in the file: `fill` the scan input with the code, `press Enter`. Keep it fast,
   no waiting between scans (scanner-gun speed). Batch snapshots every ~20 codes rather than
   every scan to keep output manageable.
2. After all 124: snapshot the feed and session totals. Verify: total counted increased by
   exactly 124 (plus whatever Phase A added). Every code visible on the feed (verified,
   suggested, or unidentified - identity doesn't matter, presence + count does).
3. Also record HOW each code resolved: how many showed instant known vs "decoding..." then
   settled vs went to Needs Review.

## Phase C - network forensics (the owner's real question)

1. Use `requests` and `response-body <n>` on the `/api/ai-lookup` calls captured during Phase B.
2. For a sample of at least 10 codes, extract from the response: which ladder rung answered
   (tire corpus / retail corpus / learned products / master catalog / persisted cache / memory cache /
   GPT-5.4 mini), the reason strings, and timing.
3. Answer with evidence: are these codes served from cache/learned tier (free, and only the UI
   makes it look like a fresh decode)? Or genuinely re-decoding (cache miss)? Or not in the
   master DB at all? Architecture pointers: `src/server/decode/pipeline.ts` (rung order),
   `services/resolver.ts` (known = approved alias/verified product ONLY - AI results are never
   auto-saved as aliases, so re-scans are EXPECTED to hit the ladder; the question is whether
   the ladder answers free from L1). Canonical doc: `docs/DECODER_ARCHITECTURE.md`.
4. Per the standing "trace every non-decode" rule: if any code fails or misbehaves, root-cause
   the CLASS, not the single example.

## Report back (to the owner, in plain language)

- What paste-all-at-once did.
- Law check result: N scanned / N on feed / N counted (exact numbers).
- The decode mystery answer with request/response evidence, and whether anything cost money.
- Screenshots of before/after feed and totals.
- Any defect found -> root cause class + where it lives in code. Do NOT fix production or push
  anything; diagnosis only. Local code investigation is fine.
- End with `npx playwright-cli -s=tier1scan detach` (NOT close).
