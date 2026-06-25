# Weekly Report Style Guide (portable)

A recipe for reports people actually read and trust. Portable: paste it into any project's
report-writing command. No plugins. The only tool is Playwright (for screenshots). The quality is
structure + verification, not tooling.

## The one rule that matters most: verify before you print

Most ugly reports are also untrustworthy: full of already-fixed false positives. Before you call
anything a finding, confirm it in the real code or the live app. Grep for the symbol, open the
component, run the check. A short TRUE report beats a long pretty one. If you cannot verify a claim,
label it "unverified" and say what you would check, do not state it as fact.

In this project: the report generator is data-driven and the numbers come from real runs
(`scripts/weekly-tire-scan.ts` writes `scan-health.json`; `scripts/build-report-html.mjs` renders).
Findings about the app/code must be confirmed by reading the code before they ship in the report.

## The tricks

1. **Lead with the answer.** A one-line TL;DR headline, then a "do these first" top list, at the very
   top. The reader gets the gist in 30 seconds with no scrolling.
2. **Plain English.** Every finding says three things: what it is, why it matters to the reader, and
   what to do. No jargon, no stack traces, no internal terms.
3. **Tables and cards, not walls of text.** Use colored severity chips (blocker / high / medium / low)
   so the eye lands on the worst first. Group by "Do now / Do next / Do later" when it helps.
4. **Show, do not tell.** For anything visible, put before/after screenshots side by side, numbered,
   with a one-line caption. Playwright captures them.
5. **One self-contained HTML file.** Inline CSS, neutral professional palette, no external assets, no
   trade-specific branding. It must open in any browser and survive being attached as a PDF.
6. **Cut everything that does not earn its place.** Match length to substance. If a section is filler,
   delete it. Whitespace is a feature.

## Severity chips (drop-in)

```html
<span class="chip blocker">blocker</span>
<span class="chip high">high</span>
<span class="chip med">medium</span>
<span class="chip low">low</span>
<style>
  .chip{display:inline-block;font:600 11px ui-monospace,monospace;border-radius:999px;padding:2px 9px}
  .chip.blocker{background:#fde2e1;color:#9b1c1c}
  .chip.high{background:#fde2e1;color:#c0392b}
  .chip.med{background:#fdf0d9;color:#b7791f}
  .chip.low{background:#e7eefb;color:#2563eb}
</style>
```

## Before/after pattern (drop-in)

```html
<figure class="ba">
  <div><img src="before.png" alt="before"><figcaption>1. Before</figcaption></div>
  <div><img src="after.png" alt="after"><figcaption>2. After</figcaption></div>
</figure>
<style>.ba{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ba img{width:100%;border:1px solid #e4e8ef;border-radius:8px}.ba figcaption{font:12px ui-monospace,monospace;color:#5c6675;margin-top:6px}</style>
```

## Checklist before sending

- [ ] TL;DR + top-5 at the very top
- [ ] Every finding has what / why / what-to-do, in plain English
- [ ] Severity chips present and honest
- [ ] Every claim about the app/code was verified (grepped/opened/run); unverified items labeled
- [ ] Screenshots for anything visible, numbered, before/after where relevant
- [ ] One self-contained HTML file, inline CSS, neutral palette
- [ ] Real numbers from real runs (no invented metrics); cost shown when money was spent
- [ ] Nothing filler; cut a section rather than pad it

## What NOT to do

- Do not install a "reporting plugin." It will not fix anything. The look is structure + this guide.
- Do not pad a thin result with confident language.
- Do not ship a finding you have not confirmed is still real.
