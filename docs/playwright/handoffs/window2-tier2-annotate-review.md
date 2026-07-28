# Handoff: Window 2 - Tier 2 owner-annotated UI review (show --annotate)

You are running the Tier 2 Playwright CLI session for the Scanbin project: an interactive UI
review where the OWNER draws boxes and writes notes directly on the live page, and you receive
the annotated screenshot + snapshot + notes. Read this whole file before acting. Skill
reference: `.claude/skills/playwright-cli/SKILL.md` (see "Example: Interactive session").

## Mission

On the LIVE PRODUCTION site `https://inventory-lovat-six.vercel.app`, in the owner's OWN Chrome
(attached), open the annotation dashboard so the owner can mark up the UI screen by screen.
Collect every annotation, then turn them into a concrete, prioritized fix list. Diagnosis and
planning ONLY - no production changes, no push, no deploy.

## Hard constraints (owner orders)

- PRODUCTION site, owner's real Chrome profile (his Vercel toolbar login lives there).
- NEVER open a new Chrome instance. Attach to the running one. Work in your OWN new tab; never
  `tab-close` or `tab-select` tabs you did not create.
- NEVER run `playwright-cli close` on the attached browser - it would close the owner's Chrome.
  End with `detach` only.
- Two other Claude windows share this Chrome. Use ONLY your session name `-s=tier2review` on
  every command.
- Another window may be blasting 124 scan codes into the app at the same time. If the page
  looks busy with scans, coordinate with the owner about timing before annotating the Scan page.

## Setup (owner must have done the one-time Chrome restart with --remote-debugging-port=9222)

```powershell
cd c:\Users\djsan\inventory
npx playwright-cli -s=tier2review attach --cdp=http://localhost:9222
npx playwright-cli -s=tier2review tab-new https://inventory-lovat-six.vercel.app
npx playwright-cli -s=tier2review snapshot
```

If attach fails, STOP and tell the owner Chrome needs the debug-port restart (see
`docs/playwright/handoffs/README-chrome-attach.md`).

## Review loop (repeat per screen)

Screens to walk, in order (owner can redirect): Scan page -> Needs Review queue -> Inventory /
counts table -> Reports/variance -> Settings.

For each screen:

1. Navigate there (`goto` or clicking nav), `snapshot` first so you understand the screen.
2. Launch the annotation dashboard: `npx playwright-cli -s=tier2review show --annotate`
3. Tell the owner (in chat): "Annotate the <screen> now - draw boxes, type notes, submit when
   done." Wait for the annotation result to come back.
4. Save what you receive (annotated screenshot, marked-region snapshot, notes) and echo back a
   short confirmation of what you understood from each note, so nothing is lost in translation.
5. Move to the next screen.

## After the walkthrough

1. Compile EVERY annotation into `docs/playwright/handoffs/annotate-review-YYYY-MM-DD.md`:
   one row per annotation - screen, what the owner marked, his words, your interpretation,
   proposed fix, effort (S/M/L), and a priority (P1 blocker / P2 important / P3 polish).
2. Cross-check proposals against project law before proposing anything: CLAUDE.md conventions
   (no em dashes in user copy, multi-trade product - tires never the pitch), the scanner
   workflow rules (scan input focus is sacred), and the simplicity-enforcer mindset (no bloat).
3. Present the prioritized list to the owner in plain language and ask which items to green-light.
   Do NOT implement anything in this window without his pick. UI changes, when approved, follow
   the browser-proof gate (`docs/REVISION_GATE.md`).
4. End with `npx playwright-cli -s=tier2review detach` (NOT close).
