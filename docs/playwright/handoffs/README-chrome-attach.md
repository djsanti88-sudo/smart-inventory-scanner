# One-time setup: let Playwright CLI attach to YOUR Chrome (keeps all logins)

All three Claude windows must use the owner's existing Chrome (Vercel toolbar is logged in via
his Gmail there), never a new browser. Chrome only accepts outside connections when started
with a debug port. Verified 2026-07-22: Chrome was running WITHOUT it.

## Owner does once

1. Close Chrome completely (all windows; check the system tray / `chrome` gone from Task Manager).
2. Start it with the debug port (same profile, so Gmail/Vercel logins are all still there):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

3. Tell the Claude windows "Chrome is ready".

## Each Claude window then runs (own session name!)

```powershell
npx playwright-cli -s=<yourname> attach --cdp=http://localhost:9222
npx playwright-cli -s=<yourname> tab-new <url>
```

Session names in use: `tier1scan` (window 1), `tier2review` (window 2), `vercelbug` (window 3).

## Rules for a shared browser

- Every command carries your `-s=<yourname>`.
- Only touch tabs YOU created (`tab-new`); never `tab-close`/`tab-select` others.
- NEVER `close` (closes the owner's whole Chrome). Finish with `detach`.
- The debug port is local-only but powerful; when all three windows are done, the owner can
  restart Chrome normally (without the flag) to shut the door.
