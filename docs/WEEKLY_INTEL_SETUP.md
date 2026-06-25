# Weekly Intelligence Report - setup

The weekly report runs a 27-agent Claude fleet over the app, writes an HTML + PDF report with
local-vs-live drift detection, and emails it to djsanti88@gmail.com. It runs on the Claude
subscription (the AI decode route is mocked), so it spends nothing on API keys.

## On-demand (works right now)

```
npm run intel:now      # weekly fleet, both targets, render + email if creds are set
npm run intel:local    # local mock only
npm run intel:live     # live real-account only (needs god creds, see below)
npm run intel:validate # sanity-check all agent files
```

If email credentials are not set, the run still writes `reports/product-intel/<date>/report.html`
and `report.pdf` locally and prints `emailed=false reason=no-credentials` (it does not fail).

## 1. Turn on automatic email (one-time, free, no API key)

Gmail blocks plain passwords, so create a free **app password**:

1. Enable 2-Step Verification on the Google account (myaccount.google.com/security).
2. Go to myaccount.google.com/apppasswords, create one named "Smart Inventory".
3. Add these two lines to `.env.local` (this file is gitignored, never commit it):

```
GMAIL_USER=djsanti88@gmail.com
GMAIL_APP_PASSWORD=the-16-char-app-password
```

After that, every run emails the report automatically with the PDF attached.

## 2. Turn on the live-data half (optional)

The live half logs into the real god account and judges your real inventory. Add to `.env.local`:

```
GOD_EMAIL=your-god-account-email
GOD_PASSWORD=your-god-account-password
```

Without these, the run is local-only and the report marks live as "not configured" (no failure).

## 3. Schedule it for Sundays 6:00 PM (one-time)

```
powershell -ExecutionPolicy Bypass -File scripts/register-weekly-task.ps1
schtasks /query /tn SmartInventoryWeeklyIntel
```

Notes:
- The PC must be on at run time. The task is set to catch up on next wake if it was asleep.
- The trigger uses machine local time. If your machine is not on America/Chicago, adjust the
  `-At 6:00PM` value in `scripts/register-weekly-task.ps1` and re-run it.
- To remove it: `schtasks /delete /tn SmartInventoryWeeklyIntel /f`

## What you get in the email

A skimmable report led by a plain-English "Top priorities this week" list, then a score grid, the
local-vs-live Publish-Gap (did you forget to commit or publish), product findings by lens with
screenshots, and a Growth and business section (ROI, activation, retention, marketing, pricing,
growth loops, competitor gaps, roadmap).
