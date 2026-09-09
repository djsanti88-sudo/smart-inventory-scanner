# Weekly report

This is the canonical setup and quality guide for Scanbin's weekly intelligence report.

## Run

```bash
npm run intel:now
npm run intel:report
npm run intel:validate
```

Only these current package scripts are documented. `intel:now` runs the configured report workflow;
`intel:report` renders from existing artifacts; `intel:validate` checks the agent definitions. Read
`docs/COMMANDS.md` before any mode that may touch a live account, send email, or call a paid service.

Reports are written below `reports/product-intel/<date>/`. Email is optional and requires
`GMAIL_USER` and `GMAIL_APP_PASSWORD` in gitignored `.env.local`. Live-account inspection requires
the owner-approved credentials documented in `docs/COMMANDS.md`. Never put credential values in a
report or commit them.

The local Windows scheduler is registered with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-weekly-task.ps1
schtasks /query /tn SmartInventoryWeeklyIntel
```

The computer must be available at run time. Registering, changing, or removing an external delivery
or scheduler remains owner-controlled.

## Report quality contract

1. Lead with one plain-English conclusion and the few highest-value actions.
2. State what happened, why it matters, and what to do for every finding.
3. Verify claims against current code or the running app. Label anything else `unverified` and name
   the missing check.
4. Use real measurements from the run. Never invent metrics or infer provider spend from response
   metadata alone.
5. Include screenshots for material visible findings and inspect rendered HTML/PDF for clipping,
   overlap, missing content, and unreadable text.
6. Separate local, mock, Preview, and authenticated-production evidence.
7. Prefer a short trustworthy report over filler.

Severity must reflect impact and evidence. A blocker prevents a safe release or risks customer data,
count integrity, security, or uncontrolled spend. Lower severities must not be inflated for visual
effect.

## Before delivery

- [ ] The summary and priorities appear first.
- [ ] Every finding has evidence and a clear action.
- [ ] Unverified claims are labeled honestly.
- [ ] Customer-visible findings include inspected screenshots when useful.
- [ ] The output opens without external assets and renders cleanly to PDF.
- [ ] Costs use provider-console truth when money was spent.
- [ ] The report states whether email or any external delivery actually occurred.
