# Registers the weekly intelligence report as a Windows Scheduled Task.
# Run ONCE from the project root:  powershell -ExecutionPolicy Bypass -File scripts/register-weekly-task.ps1
# Runs every Sunday 6:00 PM local time. Assumes the machine timezone is America/Chicago
# (adjust the -At time if your machine is in a different zone).

$proj = (Resolve-Path "$PSScriptRoot\..").Path
$logDir = Join-Path $proj "reports\product-intel"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

$action = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument "/c cd /d `"$proj`" && npm run intel:now >> `"$logDir\cron.log`" 2>&1"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 6:00PM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun
Register-ScheduledTask -TaskName "SmartInventoryWeeklyIntel" `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description "Smart Inventory weekly product and growth intelligence report" -Force

Write-Host "Registered SmartInventoryWeeklyIntel for Sundays 6:00 PM."
Write-Host "It catches up on next wake if the PC was asleep. On-demand any time: npm run intel:now"
