# Claude Code Stop hook: forward the hook payload to the Python hook_support
# module and, if it says FIRE, launch a hidden, detached, deterministic-only
# Fable 5 review. All decision logic lives in Python (unit-testable); this
# script is a thin transport layer only.
#
# Stdin: the JSON payload Claude Code passes to Stop hooks (includes
# transcript_path). We pipe it straight through unmodified.

$proj = (Resolve-Path "$PSScriptRoot\..\..").Path
$stdin = [Console]::In.ReadToEnd()

$output = $stdin | python -m tools.fable5.hook_support stop-hook --repo "$proj" 2>&1
Write-Output $output

if ($output -match "FIRE") {
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
