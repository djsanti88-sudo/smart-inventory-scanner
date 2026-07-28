# MASTER HANDOFF - Scanbin production testing in the owner's logged-in Chrome

You are the executing Claude window. The owner wants ALL of this run with the **Playwright CLI**
(`npx playwright-cli ...`, skill: `.claude/skills/playwright-cli/SKILL.md`) against LIVE
PRODUCTION `https://inventory-lovat-six.vercel.app`, inside a Chrome that **has his Gmail
account / Vercel login**. Read this WHOLE file before doing anything. Repo:
`c:\Users\djsan\inventory` (run all commands from there).

## STEP 0 - Getting into a logged-in Chrome (read carefully, this burned a prior session)

Hard facts, verified 2026-07-22 on this machine (Chrome 150.0.7871.130):

- Chrome 136+ **refuses remote control of the default user profile**. `--remote-debugging-port`
  is silently ignored for it. You CANNOT attach to the Chrome window the owner already has open.
  Do not try. Do not argue. Do not suggest the Playwright extension - the owner has explicitly
  and repeatedly REFUSED the extension.
- The way to satisfy "a Chrome with my Gmail connected" WITHOUT the extension and WITHOUT
  touching his live default profile: **clone the profile** to a second directory and launch that
  clone with the debug port. Cookies/logins (Gmail, Vercel toolbar) carry over. Chrome allows
  CDP on non-default data dirs.

Do this ONCE (owner should close Chrome first so the profile files are not locked - ASK him,
one line, then wait):

```powershell
# 1) clone the profile (first run takes a few minutes; ~1-2 GB)
robocopy "$env:LOCALAPPDATA\Google\Chrome\User Data" "$env:LOCALAPPDATA\Google\Chrome\UserDataPW" /E /XJ /R:1 /W:1 /NFL /NDL /NJH

# 2) launch the clone with the remote-control door open
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\UserDataPW" --remote-debugging-port=9222

# 3) verify the door is open
Test-NetConnection localhost -Port 9222   # TcpTestSucceeded must be True
```

Tell the owner he can reopen his normal Chrome afterwards; the clone is a separate window that
Playwright drives. Verify in the clone that his Google account shows top-right (screenshot it).
If Google signed the clone out (it sometimes invalidates copied cookies), tell the owner to
sign in ONCE in the clone window - it persists for all future runs.

Then attach the CLI (each mission uses its OWN session name):

```powershell
npx playwright-cli -s=<sessionname> attach --cdp=http://localhost:9222
npx playwright-cli -s=<sessionname> tab-new https://inventory-lovat-six.vercel.app
```

## Shared rules (all missions)

- Playwright CLI ONLY (shell `npx playwright-cli ...`). Not MCP browser tools.
- Every command carries `-s=<sessionname>`. Only touch tabs YOU created with `tab-new`.
- NEVER `close` an attached browser (closes the whole clone Chrome mid-run) - `detach` when done.
- Diagnosis only: never modify production, never push, never deploy, no fixes applied.
- Screenshots are proof: save with `screenshot --filename=docs/playwright/handoffs/proof/<mission>-<step>.png`.
- Missions 1 and 2 may run in parallel via subagents (different session names, different tabs).
  Mission 3 needs the owner at the keyboard - run it AFTER mission 1's blast so the feed is calm.

## Mission 1 - 124-code scan blast + "why do saved codes re-decode" forensics

Session name: `tier1scan`. Full spec: `docs/playwright/handoffs/window1-tier1-scan-blast.md`
(use its Phases A/B/C exactly, but attach per STEP 0 above instead of its setup section).
Codes: `docs/playwright/handoffs/codes-124.txt` (one per line, 124 total).

Summary: (A) paste ALL 124 codes into the scan bar in one paste, record what the app does;
(B) then one-by-one at scanner speed - verify TOP-LEVEL LAW: 124 scanned = 124 on feed = 124
counted; (C) network forensics on `/api/ai-lookup` via `requests`/`response-body`: for 10+
codes report which ladder rung answered and the `cached`/`persistedCacheHit` debug flags.
Core question: does production PERSIST decodes (Turso) or re-decode every time (suspect:
TURSO_DATABASE_URL/TURSO_AUTH_TOKEN missing from Vercel prod env)?
COST GUARD: if paid rungs (goupc/fetchv2/gpt) fire for these previously-scanned codes, STOP
after 10, capture evidence, report - do not pay 114 more times.
NOTE: scans add counts to the profile-clone's local state - harmless, but report the final
counts so the owner knows.

## Mission 2 - Vercel "timing interaction" error investigation

Session name: `vercelbug`. The owner sees an error from Vercel on production he describes as
"timing interaction". Identify what it actually is, with evidence. Candidates: Speed Insights
INP (Interaction to Next Paint) warning, Vercel Toolbar script error, app console/network error.

Steps: load prod in your own tab; collect `console` + `requests` (look for vercel/vitals/
speed-insights/toolbar traffic and failures); find the Vercel toolbar (his login is in the
cloned profile, so it should be live); reproduce by using the app like a user (scan input,
navigation) while watching console; if needed use `run-code` with a PerformanceObserver on
'event'/'longtask' entries to capture worst interaction latencies and the elements involved;
grep the repo (`@vercel/analytics`, `speed-insights`, toolbar) to tie findings to code.
Deliver: verbatim error text, who emits it, what triggers it, real UX problem vs telemetry
noise, code pointer, proposed fix (proposal ONLY).

## Mission 3 - Owner-annotated UI review (owner at keyboard)

Session name: `tier2review`. Full spec: `docs/playwright/handoffs/window2-tier2-annotate-review.md`
(attach per STEP 0 instead of its setup section). Walk Scan -> Needs Review -> Inventory ->
Reports -> Settings; on each screen run `show --annotate`, tell the owner to draw boxes + notes,
collect results, and compile the prioritized fix table
(`docs/playwright/handoffs/annotate-review-2026-07-22.md`). No implementation without his picks.

## Final report to the owner (plain language, no jargon)

1. Mission 1: paste-at-once behavior; law-check numbers (scanned/feed/counted); the decode
   mystery answer WITH evidence; whether anything cost money.
2. Mission 2: what the Vercel error really is and whether it matters.
3. Mission 3: the prioritized annotation fix list awaiting his green-light.
4. Defects -> root-cause CLASS + code pointers (per the standing trace-every-non-decode rule).
5. Screenshots list. 6. Spend report (tokens/credits/$ - he always wants it).
