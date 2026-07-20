# Claude Code SessionStart hook: print up to 4 lines of Fable 5 status
# (latest verdict, a running background review, a pending preview-stress
# offer) into the new session. All composition logic lives in Python
# (unit-testable); this script only invokes it and prints its output.

$proj = (Resolve-Path "$PSScriptRoot\..\..").Path
python -m tools.fable5.hook_support sessionstart-hook --repo "$proj"
