# WebsiteBuyerBot — buyer's-eye review

No public marketing website exists in this repo yet; this reviews the **app demo surface** (the screens a
prospect would see in a demo) as a buyer, plus what the future site must do.

## Buyer questions
1. **Value clear in 30s?** Not yet from the app itself — the scan page looks like a developer/engine tool
   (raw code columns, "AI lookup", Settings full of knobs). The *value* (accuracy + speed) needs a framed demo.
2. **Obviously inventory scanning?** Yes once on the scan page (scan box + live feed + count table).
3. **Tire/shop use case obvious?** No — seed data is generic; nothing signals "tire/auto." Add tire/auto branding + sample data.
4. **Pain point clear?** No — needs a one-liner: "Stop counting tires with a clipboard and getting the wrong part."
5. **ROI clear?** No — show "count a 500-item room in an afternoon, no duplicates, no wrong matches."
6. **Trust?** Thin — no logos, testimonials, or security statement. Add "your codes stay yours" + a design-partner quote.
7. **Screenshots strong?** The multi-code moment + the mismatch-guard banner are strong; raw-code-heavy
   tables are weak/scary. Curate.
8. **Above the fold (website):** promise sentence + 20s multi-code scan loop + one CTA.
9. **CTA:** "Book a 15-minute setup call" (pilot is white-glove; not self-serve yet).
10. **Proof to show:** the scan-the-part-number-and-it's-the-same-tire clip; a before/after count time; "no
    wrong-product" guard; "data stays private."
11. **Remove:** raw code/GTIN columns, "AI/Gemini/OpenAI" wording, engine settings — from anything a prospect sees.
12. **Simplify:** onboarding to "Scan → tell us unknowns once → export."
13. **Demo video:** the 90-second flow from marketing_advice.md §3.
14. **Hide (secret sauce):** the global/shared code library, alias internals, resolver/normalizer mechanics, provider names.

## Verdict
The product *demos* well in a guided 90 seconds but does **not yet self-sell** — because internal/engine
surfaces are visible (also the Track 1 P0 security item). The highest-leverage pre-pilot work is the
**customer-facing cleanup + de-branding** (hide internals), which simultaneously fixes the moat leak and
makes the app look like a shop tool, not a dev tool.
