@echo off
REM Discount Tire weekly top-up - unattended runner (Windows Task Scheduler entry point).
REM Registered 2026-07-09 with owner approval. Runs scripts/dt-harvest/weekly.mjs:
REM   discover new URLs -> capped 500-page crawl -> apply to corpus -> write a report.
REM weekly.mjs exits NON-ZERO on any anomaly (block rate > 5%, errors > 10%, spot-check
REM fail, hard stop, batch crash, unparseable apply) so the exit code alone signals trouble.
REM Requires: the machine on at fire time + Playwright installed (already a dev dep).
REM Report per run: scripts/dt-harvest/state/weekly-report-<date>.md
REM Log per run:    scripts/dt-harvest/state/weekly-cron.log (appended)
REM To remove the schedule:  schtasks /delete /tn "DT-Harvest-Weekly" /f

cd /d "C:\Users\djsan\inventory"
echo(>> "scripts\dt-harvest\state\weekly-cron.log"
echo ===== weekly run started %DATE% %TIME% ===== >> "scripts\dt-harvest\state\weekly-cron.log"
node "scripts\dt-harvest\weekly.mjs" >> "scripts\dt-harvest\state\weekly-cron.log" 2>&1
echo ===== weekly run exited code %ERRORLEVEL% at %DATE% %TIME% ===== >> "scripts\dt-harvest\state\weekly-cron.log"
exit /b %ERRORLEVEL%
