# Live Decode Diagnosis (UPC lookup)

Date: 2026-06. Diagnosed against the running dev server + a real `LIVE_AI_TEST=1` smoke run.

## What was wrong
1. **Providers were not using web search / grounding.** The Gemini provider called `generateContent`
   with no `google_search` tool, and OpenAI used `chat/completions` (no `web_search` tool). So neither
   actually searched the live web, and neither returned `groundingMetadata` / source URLs / snippets.
   Result: `EvidenceVerifier` always saw EMPTY evidence -> strength "none" -> nothing could verify.
2. **Decision ladder buried good results.** A single provider returning a product with weak evidence
   was routed to a blank `needs_review` instead of a sourced `Suggested`.
3. **Numeric evidence matching missed GTIN padding.** A 12-digit UPC appears in sources as the
   13/14-digit GTIN (leading zeros), so even when the exact code was in a URL it wasn't matched.

Config was NOT the problem: GET /api/ai-lookup showed liveEnabled/autoDecode/gemini+openai
enabled & configured, e2e false, no missing keys, not emergency-stopped.

## What was fixed
- **Gemini** now sends `tools: [{ google_search: {} }]` and extracts `groundingMetadata`
  (`groundingChunks[].web.uri/title` -> sourceUrls/snippets, `groundingSupports[].segment.text` ->
  grounding chunks).
- **OpenAI** now uses the **Responses API** with `tools: [{ type: "web_search" }]` and extracts
  `url_citation` annotations -> sourceUrls + cited snippets.
- **Prompt** instructs the model to search for the EXACT code, return a best-guess product even when
  unsure (uncertainty in `guesses`), and cite every page in `sourceUrls`.
- **Decision ladder**: any usable product identity -> `Suggested` (with sources + reason). `needs_review`
  only when NO provider returned a product. Never a blank row when results exist.
- **EvidenceVerifier**: numeric codes now match across zero-padding variants (UPC-12 / GTIN-13 / 14).
- **Retry**: 4xx (quota/auth) errors are no longer retried (saves tokens).
- **UI**: review shows the decode badge, per-provider results (Gemini / OpenAI), evidence strength,
  `app-verified` yes/no, source links, and the reason - even when the product name is empty.
- **Diagnostics**: GET status reports `geminiSearchGrounding` / `openaiWebSearch`; POST decode returns
  a `debug` block (providers attempted, evidence strengths, source counts). `scripts/live-decode-smoke.ts`
  prints everything for the two test codes.

## Live smoke results (LIVE_AI_TEST=1, real calls) - saved in LIVE_SMOKE_OUTPUT.txt
- `012300197410` -> **OpenAI web search decoded it: "Camel Crush Regular Menthol Cigarettes, Box"**,
  8 source URLs incl. ones containing the exact code (foodland, buycott, upcitemdb). Evidence
  strength **url_only** (after the GTIN-variant fix). Decision: **Suggested** with sources. Matches
  what ChatGPT found.
- `070330645936` (BIC) -> OpenAI web search found barcode-DB pages but did not return a confident
  product (empty / "UNKNOWN"). Decision: Suggested/Needs Review with the sources shown.

## Why it still cannot fully match ChatGPT on every code (honest limits)
1. **Gemini is returning HTTP 429 "You exceeded your current quota."** The Gemini key has no
   remaining quota/billing, so Google Search grounding (the strongest barcode decoder) never runs and
   the app falls back to OpenAI only. **Action: check Gemini billing at https://ai.dev/rate-limit.**
2. **OpenAI web_search returns source URLs but few/no text snippets**, so evidence stays `url_only`
   (weak) and never reaches `Verified AI Decode`. To reach Verified, the app needs snippet/grounding
   text containing the exact code - which Gemini grounding provides (once quota is restored), or which
   a future "fetch + read the source page" step would provide.
3. **The BIC code** wasn't matched by OpenAI's web_search alone. Mitigations: restore Gemini quota,
   set `ENABLE_PREMIUM_MODEL_FALLBACK=true` (escalates to gpt-5 on weak results), or add page-fetching.

## Update 2 - page-fetch-and-read + pro models (the real upgrade)
- **Forced pro models** for live decode: Gemini `gemini-2.5-pro`, OpenAI `gpt-5` (web search on),
  premium fallback now ON by default. Overridable via `GEMINI_DECODE_MODEL` / `OPENAI_DECODE_MODEL`.
- **Added the page-fetch-and-read step** (`src/services/ai/pageFetch.ts`): the app builds barcode-DB
  URLs from the code (go-upc, upcitemdb, barcodesdatabase, barcodelookup, buycott) + the providers'
  source URLs, **opens the pages server-side, strips them to text, confirms the exact code is on the
  page (strong `fetched_source` evidence), and a fast model (`gpt-5-mini`) reads out the product.**
  This is exactly what a person/the ChatGPT website does. Re-decides with the fetched evidence.
- Page-read uses a FAST model so a decode is not minutes long (reading text is easy work).

### Live proof (LIVE_AI_TEST=1, real calls, everything maxed)
- `012300197410` -> **VERIFIED AI DECODE**: "Camel Crush Box", `exactCodeEvidenceVerifiedByApp: true`,
  evidence `fetched_source` (the page-fetch opened barcodesdatabase.org, read it, confirmed the code).
  Shows the product in the feed; does NOT go to Needs Review.
- `070330645936` (BIC) -> OpenAI returned a BIC lighter product (Suggested). The barcode pages DO
  return "Bic Lighters Texas State Star..." to a server fetch (verified with curl), so the page-fetch
  + barcodesdatabase source now targets it.

### Remaining hard blocker (owner-side)
- **Gemini returns 429 even on `gemini-2.5-pro`** -> the API key's Google project has no quota/billing
  for the Generative Language API. "Having credit" on Google Cloud is not enough if the credit/billing
  is on a different project than the key. **Fix: in Google AI Studio / Cloud, enable billing on the
  project that owns this key (or make a new key from a billing-enabled project).** Until then only
  OpenAI + page-fetch run (which is enough to VERIFY codes that are in the public barcode databases).

### Speed note
- With pro models + web search + premium + page reads, a single live decode took 1-3.6 min. The
  fast page-read model cuts this. If still too slow, set base `OPENAI_DECODE_MODEL=gpt-5-mini` (the
  page-fetch provides the verification, so the base model doesn't have to be the slow pro one).

## Bottom line
The live decode pipeline is now real and working: it searches the web (OpenAI), extracts sources,
independently verifies the exact code, and shows the best sourced suggestion instead of a blank
Needs Review. Full "Verified AI Decode" on these tobacco/lighter UPCs needs the Gemini quota restored
(grounding text) and/or premium fallback enabled - both are owner-side toggles, not app bugs.
