# Claude Code Stop hook: forward the hook payload to the Python hook_support
# module and, if it says FIRE, launch a hidden, detached, deterministic-only
# Fable 5 review. All decision logic lives in Python (unit-testable); this
# script is a thin transport layer only.
#
# Stdin: the JSON payload Claude Code passes to Stop hooks (includes
# transcript_path). We pipe it straight through unmodified.
#
# F-11 (owner order, 2026-07-29): env-driven no-write/dry-run mode. When
# $env:SCANBIN_HOOKS_DRY_RUN is "1" or "true", the stdin/hook_support decision
# call still runs (so FIRE/no-FIRE logic stays exercised and testable), but the
# detached review-build process - which is the thing that eventually writes
# report artifacts to disk - is never spawned. Without the flag set, behavior
# is unchanged.

$proj = (Resolve-Path "$PSScriptRoot\..\..").Path
$stdin = [Console]::In.ReadToEnd()
$noWrite = ($env:SCANBIN_HOOKS_DRY_RUN -eq "1") -or ($env:SCANBIN_HOOKS_DRY_RUN -eq "true")

$output = $stdin | python -m tools.fable5.hook_support stop-hook --repo "$proj" 2>&1
Write-Output $output

if ($output -match "FIRE" -and $noWrite) {
    Write-Output "SCANBIN_HOOKS_DRY_RUN set: skipping detached review-build spawn (no-write mode)."
}
elseif ($output -match "FIRE") {
    # FABLE5_HOOK_TRIGGERED is set via $env: before Start-Process rather than
    # passed as a process-specific -Environment argument, because
    # Start-Process has no per-call environment override on Windows
    # PowerShell 5.1 short of building a full ProcessStartInfo by hand. We
    # deliberately omit -UseNewEnvironment so the child inherits the parent's
    # environment (PATH, PYTHONPATH, etc.) with FABLE5_HOOK_TRIGGERED added on
    # top; a fresh/empty environment would break `python -m` resolution.
    $env:FABLE5_HOOK_TRIGGERED = "1"
    Start-Process -WindowStyle Hidden -WorkingDirectory "$proj" -FilePath "python" `
        -ArgumentList "-m", "tools.fable5", "review-build", "--gate", "fast"
}
