#!/usr/bin/env python3
"""
firecrawl_client.py — Credit Firewall for the Tire Barcode Harvester.

Every Firecrawl CLI call MUST go through `call()`. No module may invoke
`firecrawl` directly. This module enforces:
  - Kill switch (.firecrawl_STOP file presence)
  - Per-run credit cap (PER_RUN_CAP)
  - Total-lifetime credit cap (TOTAL_CAP)
  - Credit measurement before/after each real call
  - Persistent spend accounting in firecrawl_policy.json

Credit semantics (confirmed by running `firecrawl --status`):
  Output line: "Credits: 160 / 1,000 (16% left this cycle)"
  The FIRST number (160) is REMAINING credits available to spend.
  The SECOND number (1,000) is the total credits in this billing cycle.
  "16% left this cycle" = 160/1000 = 16% — confirms 160 is REMAINING.
  `get_remaining_credits()` returns the REMAINING (available) credits.
"""

import json
import os
import re
import shlex
import subprocess
import sys
import unicodedata

# ROOT is the harvester root directory (parent of the scripts/ folder).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_POLICY_FILE = "firecrawl_policy.json"

# On Windows, npm-installed CLI tools are .cmd scripts and require shell=True
# to be found by subprocess. On POSIX (Linux/macOS) use a list directly.
_SHELL = sys.platform == "win32"

# ANSI escape code stripper
_ANSI_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]')

# Matches the Credits line after ANSI stripping.
# Example stripped: "  Credits: 160 / 1,000 (16% left this cycle)"
# Capture group 1 = remaining credits (may contain commas), group 2 = total (may contain commas).
_CREDITS_RE = re.compile(
    r'Credits:\s*([\d,]+)\s*/\s*([\d,]+)',
    re.IGNORECASE,
)


def _strip_ansi(text: str) -> str:
    """Remove all ANSI escape sequences from text."""
    return _ANSI_RE.sub('', text)


# Characters that are safe unquoted in CMD (besides CLI flags).
_WIN_SAFE_RE = re.compile(r'^[A-Za-z0-9._:/=-]+$')

# Characters that cannot be safely neutralised inside CMD double-quotes.
_WIN_UNSAFE_CHARS = {'"', '%', '!'}


def _win_quote(arg: str) -> str:
    """
    Quote *arg* for use in a Windows CMD shell=True command string.

    Rules:
    - CLI flags (start with '-') or args containing only safe chars
      ([A-Za-z0-9._:/=-]) are returned unquoted.
    - Args containing '"', '%', '!', or any control/newline char raise
      ValueError — these cannot be safely neutralised in CMD double-quotes.
      Fail closed rather than risk injection.
    - All other args are wrapped in double quotes so that CMD metacharacters
      such as & | ^ < > ( ) are treated as literals.
    """
    if arg.startswith('-') or _WIN_SAFE_RE.match(arg):
        return arg

    # Check for characters that cannot be safely quoted in CMD double-quotes.
    for ch in arg:
        if ch in ('"', '%', '!'):
            raise ValueError(f"unsafe arg for Windows shell: {arg!r}")
        # Reject control characters and newlines.
        cat = unicodedata.category(ch)
        if cat.startswith('C') or ch in ('\n', '\r', '\t'):
            raise ValueError(f"unsafe arg for Windows shell: {arg!r}")

    return '"' + arg + '"'


def load_policy(root: str = ROOT) -> dict:
    """Load firecrawl_policy.json from the harvester root."""
    path = os.path.join(root, _POLICY_FILE)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_policy(policy: dict, root: str = ROOT) -> None:
    """Persist firecrawl_policy.json (accumulates total_credits_spent)."""
    path = os.path.join(root, _POLICY_FILE)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(policy, f, indent=2)
        f.write("\n")


def get_remaining_credits(root: str = ROOT) -> int:
    """
    Run `firecrawl --status`, strip ANSI codes, parse the Credits line.

    Returns the REMAINING credits as an int (the first number on the Credits line,
    which is REMAINING — confirmed by the '% left this cycle' label).

    Raises RuntimeError if the output cannot be parsed. Never returns a
    guessed or hardcoded fallback.
    """
    # Use shell=True on Windows because firecrawl is an npm .cmd script.
    cmd = "firecrawl --status" if _SHELL else ["firecrawl", "--status"]
    result = subprocess.run(
        cmd,
        shell=_SHELL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    combined = result.stdout + result.stderr
    clean = _strip_ansi(combined)
    m = _CREDITS_RE.search(clean)
    if not m:
        raise RuntimeError(
            f"get_remaining_credits: could not parse Credits line from "
            f"`firecrawl --status` output.\nRaw output:\n{combined!r}"
        )
    # Remove commas from numbers like "1,000"
    remaining = int(m.group(1).replace(",", ""))
    return remaining


def kill_switch_active(root: str = ROOT) -> bool:
    """Return True if the kill switch file exists in the harvester root."""
    policy = load_policy(root)
    kill_file = policy.get("KILL_SWITCH_FILE", ".firecrawl_STOP")
    return os.path.exists(os.path.join(root, kill_file))


def call(
    cmd_args: list,
    expected_max_credits: int,
    run_state: dict,
    root: str = ROOT,
) -> dict:
    """
    Metered Firecrawl CLI gateway. All real firecrawl calls MUST go through here.

    Args:
        cmd_args: argument list AFTER the `firecrawl` executable,
                  e.g. ["map", "https://example.com"].
        expected_max_credits: worst-case credits this call might consume.
        run_state: mutable dict that must contain 'run_credits_spent' (int).
                   Updated in place on success.
        root: harvester root directory (default: resolved from this file's location).

    Returns:
        dict with keys: returncode, stdout, stderr, credits_spent.

    Raises:
        RuntimeError: if kill switch is active, any cap would be exceeded, or
                      `firecrawl --status` cannot be parsed before the call.
    """
    # (a) Kill switch — must be checked FIRST, before any policy load or spend.
    if kill_switch_active(root):
        raise RuntimeError(
            "kill switch active: kill switch file exists in harvester root. "
            "Remove it to re-enable Firecrawl calls."
        )

    # (b) Per-run cap check.
    policy = load_policy(root)
    per_run_cap = policy["PER_RUN_CAP"]
    run_spent = run_state.get("run_credits_spent", 0)
    if run_spent + expected_max_credits > per_run_cap:
        raise RuntimeError(
            f"per-run cap exceeded: run_credits_spent={run_spent} + "
            f"expected_max_credits={expected_max_credits} > PER_RUN_CAP={per_run_cap}"
        )

    # (c) Total lifetime cap check.
    total_cap = policy["TOTAL_CAP"]
    total_spent = policy.get("total_credits_spent", 0)
    if total_spent + expected_max_credits > total_cap:
        raise RuntimeError(
            f"total cap exceeded: total_credits_spent={total_spent} + "
            f"expected_max_credits={expected_max_credits} > TOTAL_CAP={total_cap}"
        )

    # (d) Measure credits BEFORE the call. Raises if unreadable — do not proceed blind.
    before = get_remaining_credits(root)

    # (e) Run the actual firecrawl command.
    # On Windows, build a shell string to handle the .cmd npm wrapper.
    if _SHELL:
        # Quote each argument for CMD using the safe Windows quoter.
        # shlex.quote() produces POSIX single-quotes that CMD does not honour.
        cmd_str = "firecrawl " + " ".join(_win_quote(a) for a in cmd_args)
        proc = subprocess.run(
            cmd_str,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    else:
        proc = subprocess.run(
            ["firecrawl"] + cmd_args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    # (f) Measure credits AFTER the call.
    after = get_remaining_credits(root)
    spent = max(0, before - after)

    # (g) Update spend accounting.
    run_state["run_credits_spent"] = run_spent + spent
    policy["total_credits_spent"] = total_spent + spent
    save_policy(policy, root)

    # (h) Return result.
    return {
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "credits_spent": spent,
    }
