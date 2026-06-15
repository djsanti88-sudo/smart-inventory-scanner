# MarketingAdvisorBot — advice for Smart Inventory Scanner

Specific to this app (barcode/QR inventory for tire/auto shops + parts rooms). Grounded in the actual
feature set (see docs/CURRENT_CONTEXT.md) and Track 1 findings.

## 1. Strongest value proposition
**"Scan any code on the box — the right product, every time."** The differentiator isn't "inventory
software"; it's *resolution accuracy*: a tire's barcode AND its part number (dashed, spaced, slashed) all
resolve to the same product, and the app blocks wrong-category mislinks (the Falken-to-cigarettes mistake).
Incumbents count items; SIS gets the *identity* right and learns it once.

## 2. One-sentence promise
"Count your shop's inventory in an afternoon — scan any code, get the right part, no duplicates, no wrong matches."

## 3. First demo (90 seconds)
1. Scan a tire barcode → instant row. 2. Scan the same tire's *part number with a dash* → same product,
count goes up (the "wow"). 3. Scan an unknown code → Needs Review (no wrong guess). 4. Try to link it to
the wrong product → red warning blocks it. 5. Export the count to CSV. Lead with #2 — it's the unique moment.

## 4. Screenshots that sell
- Live feed showing two different codes → one product (the multi-code moment).
- The red "Possible wrong product" guard banner.
- Final Count table + one-click CSV export.
- A clean mobile-width scan screen (shop-floor credibility).

## 5. Emphasize
Accuracy ("no wrong products"), speed ("scan like a keyboard"), no-duplicates, learns-your-codes, works
offline, exports to your spreadsheet/shop system, tire/auto fit.

## 6. Hide from customer-facing language (secret sauce / internal)
The shared/global code knowledge base, alias internals, GTIN/UPC/EAN maps, the resolver/normalizer
mechanics, provider names, and that AI is involved. Customers buy outcomes, not the engine — and the
code DB is Santiago's moat (must not be exposed/exportable to customers; P0 per Track 1).

## 7. Word replacements (customer-facing)
- "AI lookup / AI decode / Gemini / OpenAI / Firecrawl" → **"Product lookup" / "Auto-identify"**
- "alias" → **"extra code" / "also scans as"**
- "GTIN/UPC/EAN map", "global catalog" → **"product library"** (and keep it non-exportable)
- "normalized code / resolver" → **"smart matching"**
- "Needs Review" → keep, but subtitle: **"Unknown code — tell us what it is once, and it's remembered."**

## 8. Shop-owner objections
1. "We already use a spreadsheet/Shop-Ware." 2. "Too complex / staff won't learn it." 3. "Will it scan
our weird vendor codes?" 4. "Is my data safe / can a competitor get it?" 5. "What does it cost vs Sortly's $49?"

## 9. Proof to overcome them
1. Time a real count vs spreadsheet on the demo. 2. Counter can scan with zero training (Track 1 UX bot:
scan input is the focused default). 3. The multi-code/separator demo answers "weird codes." 4. "Your codes
stay yours — nobody can export the database" (after the P0 data-protection fix). 5. Price on *accuracy +
niche fit*, not feature count (see pricing_recommendations.md).

## 10. Website should say
Hero: the one-sentence promise + a 20s loop of the multi-code scan. Three tiles: Scan fast · Right product
every time · Export anywhere. A tire/auto photo. One CTA: "Book a 15-min setup call" (pilot is white-glove).

## 11. App onboarding should say
"1) Scan a product. 2) If it's unknown, tell us once. 3) Watch your count build. 4) Export when done."
Three steps, plain words, no "AI/alias/GTIN."

## 12. Confusing from a buyer view
Today the customer UI shows raw codes/GTIN columns + "AI lookup" wording + Settings full of engine knobs —
this reads as "developer tool," not "shop tool." Hiding internals (the deferred role/de-branding work) is
both a security P0 and the single biggest *marketing* unlock.

Sources: competitor pricing in competition_report.md.
