# Claude Code SessionStart hook: print up to 4 lines of Fable 5 status
# (latest verdict, a running background review, a pending preview-stress
# offer) into the new session. All composition logic lives in Python
# (unit-testable); this script only invokes it and prints its output.

$proj = (Resolve-Path "$PSScriptRoot\..\..").Path
python -m tools.fable5.hook_support sessionstart-hook --repo "$proj"

# --- Doc-freshness orientation (additive, non-fatal): one line naming the
# newest dated plan under docs/superpowers/plans/ and REPO_HEALTH.md's
# "Last updated" date, with a warning if that date is more than 7 days old.
try {
    $plansDir = Join-Path $proj "docs\superpowers\plans"
    $newestPlan = "(no plans found)"
    if (Test-Path $plansDir) {
        $planFile = Get-ChildItem -Path $plansDir -Filter "*.md" -File | Sort-Object Name -Descending | Select-Object -First 1
        if ($planFile) {
            $newestPlan = $planFile.Name
        }
    }

    $repoHealthPath = Join-Path $proj "REPO_HEALTH.md"
    $repoHealthLine = "REPO_HEALTH.md not found"
    if (Test-Path $repoHealthPath) {
        $firstLines = Get-Content -Path $repoHealthPath -TotalCount 10
        $match = $firstLines | Select-String -Pattern "Last updated:\s*(\d{4}-\d{2}-\d{2})" | Select-Object -First 1
        if ($match) {
            $lastUpdatedStr = $match.Matches[0].Groups[1].Value
            $lastUpdatedDate = [datetime]::ParseExact($lastUpdatedStr, "yyyy-MM-dd", $null)
            $ageDays = (Get-Date).Date.Subtract($lastUpdatedDate).Days
            $repoHealthLine = "REPO_HEALTH.md last updated $lastUpdatedStr"
            if ($ageDays -gt 7) {
                $repoHealthLine = "$repoHealthLine (WARNING: $ageDays days old)"
            }
        } else {
            $repoHealthLine = "REPO_HEALTH.md has no 'Last updated' line"
        }
    }

    Write-Output "Doc orientation: newest plan = $newestPlan | $repoHealthLine"
} catch {
    # Never let doc-freshness orientation break session start.
}
