"""
test_firecrawl_client.py — TDD tests for the credit firewall.

ALL tests mock subprocess.run. No real firecrawl calls are made.
No Firecrawl credits are spent by this test suite.
"""

import json
import os
import sys
import tempfile
import unittest.mock as mock

import pytest

# Ensure the scripts directory is on the path.
SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPTS_DIR)

import firecrawl_client as fc

# ─── Sample ANSI-coded status output (mirrors real `firecrawl --status`) ──────
# Produced by running `firecrawl --status` against the real CLI.
_SAMPLE_STATUS_ANSI = (
    "\x1b[38;5;208m\xf0\x9f\x94\xa5 \x1b[1mfirecrawl\x1b[0m \x1b[2mcli\x1b[0m "
    "\x1b[2mv1.19.2\x1b[0m\n\n"
    "  \x1b[32m●\x1b[0m Authenticated \x1b[2mvia stored credentials\x1b[0m\n"
    "  \x1b[2mConcurrency:\x1b[0m 0/2 jobs \x1b[2m(parallel scrape limit)\x1b[0m\n"
    "  \x1b[2mCredits:\x1b[0m 160 / 1,000 \x1b[2m(16% left this cycle)\x1b[0m\n"
)

_SAMPLE_STATUS_PLAIN = (
    "  Credits: 160 / 1,000 (16% left this cycle)\n"
)

# ─── Fixtures ─────────────────────────────────────────────────────────────────


def _make_root(tmp_path: str, *, policy_overrides: dict = None, kill_switch: bool = False) -> str:
    """Create a minimal harvester root in tmp_path with a valid policy file."""
    policy = {
        "TOTAL_CAP": 50,
        "PER_RUN_CAP": 15,
        "ROWS_PER_CREDIT_FLOOR": None,
        "STEALTH_ALLOWED": False,
        "KILL_SWITCH_FILE": ".firecrawl_STOP",
        "total_credits_spent": 0,
    }
    if policy_overrides:
        policy.update(policy_overrides)
    with open(os.path.join(tmp_path, "firecrawl_policy.json"), "w", encoding="utf-8") as f:
        json.dump(policy, f, indent=2)
    if kill_switch:
        # Create the kill switch file.
        open(os.path.join(tmp_path, ".firecrawl_STOP"), "w").close()
    return tmp_path


def _status_proc(remaining: int = 160, total: int = 1000):
    """Return a mock CompletedProcess that looks like `firecrawl --status`."""
    pct = int(remaining / total * 100)
    stdout = f"  Credits: {remaining:,} / {total:,} ({pct}% left this cycle)\n"
    result = mock.MagicMock()
    result.stdout = stdout
    result.stderr = ""
    result.returncode = 0
    return result


def _cmd_proc(stdout="ok\n", stderr="", returncode=0):
    """Return a mock CompletedProcess for a real firecrawl command."""
    result = mock.MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.returncode = returncode
    return result


# ─── Test: get_remaining_credits parses ANSI output correctly ─────────────────


def test_get_remaining_credits_parses_ansi_status(tmp_path):
    """get_remaining_credits must strip ANSI codes then parse the Credits line."""
    root = _make_root(str(tmp_path))
    ansi_proc = mock.MagicMock()
    ansi_proc.stdout = _SAMPLE_STATUS_ANSI
    ansi_proc.stderr = ""
    ansi_proc.returncode = 0

    with mock.patch("firecrawl_client.subprocess.run", return_value=ansi_proc) as patched:
        result = fc.get_remaining_credits(root=root)

    patched.assert_called_once()
    assert result == 160, f"Expected 160 remaining credits, got {result}"


def test_get_remaining_credits_handles_plain_output(tmp_path):
    """get_remaining_credits works on plain (no ANSI) output too."""
    root = _make_root(str(tmp_path))
    plain_proc = mock.MagicMock()
    plain_proc.stdout = _SAMPLE_STATUS_PLAIN
    plain_proc.stderr = ""
    plain_proc.returncode = 0

    with mock.patch("firecrawl_client.subprocess.run", return_value=plain_proc):
        result = fc.get_remaining_credits(root=root)

    assert result == 160


def test_get_remaining_credits_raises_on_unparseable_output(tmp_path):
    """get_remaining_credits must raise RuntimeError if Credits line is absent."""
    root = _make_root(str(tmp_path))
    bad_proc = mock.MagicMock()
    bad_proc.stdout = "Something went wrong\n"
    bad_proc.stderr = ""
    bad_proc.returncode = 1

    with mock.patch("firecrawl_client.subprocess.run", return_value=bad_proc):
        with pytest.raises(RuntimeError, match="could not parse Credits line"):
            fc.get_remaining_credits(root=root)


# ─── Test: kill switch ────────────────────────────────────────────────────────


def test_kill_switch_blocks_call_before_subprocess(tmp_path):
    """
    When the kill switch file is present, call() must raise RuntimeError
    BEFORE invoking subprocess (no credits consumed, subprocess never called).
    """
    root = _make_root(str(tmp_path), kill_switch=True)
    run_state = {"run_credits_spent": 0}

    with mock.patch("firecrawl_client.subprocess.run") as patched_run:
        with pytest.raises(RuntimeError, match="kill switch active"):
            fc.call(["map", "https://example.com"], expected_max_credits=2,
                    run_state=run_state, root=root)

    # subprocess must NOT have been called at all.
    patched_run.assert_not_called()


def test_kill_switch_absent_does_not_block(tmp_path):
    """Without the kill switch file, call() proceeds normally."""
    root = _make_root(str(tmp_path))
    run_state = {"run_credits_spent": 0}

    # Two calls: before (160) and after (158) for the status; plus the real command.
    side_effects = [
        _status_proc(remaining=160),   # before
        _cmd_proc(stdout="urls\n"),     # real firecrawl command
        _status_proc(remaining=158),   # after
    ]
    with mock.patch("firecrawl_client.subprocess.run", side_effect=side_effects):
        result = fc.call(["map", "https://example.com"], expected_max_credits=2,
                         run_state=run_state, root=root)

    assert result["credits_spent"] == 2


# ─── Test: per-run cap ────────────────────────────────────────────────────────


def test_per_run_cap_raises_when_exceeded(tmp_path):
    """
    If run_credits_spent(14) + expected_max_credits(5) > PER_RUN_CAP(15), raise.
    subprocess must NOT be called.
    """
    root = _make_root(str(tmp_path))
    run_state = {"run_credits_spent": 14}

    with mock.patch("firecrawl_client.subprocess.run") as patched_run:
        with pytest.raises(RuntimeError, match="per-run cap exceeded"):
            fc.call(["map", "https://example.com"], expected_max_credits=5,
                    run_state=run_state, root=root)

    patched_run.assert_not_called()


def test_per_run_cap_allows_exact_boundary(tmp_path):
    """run_credits_spent(10) + expected_max_credits(5) == PER_RUN_CAP(15) is allowed."""
    root = _make_root(str(tmp_path))
    run_state = {"run_credits_spent": 10}

    side_effects = [
        _status_proc(remaining=160),
        _cmd_proc(stdout="data\n"),
        _status_proc(remaining=155),
    ]
    with mock.patch("firecrawl_client.subprocess.run", side_effect=side_effects):
        result = fc.call(["map", "https://example.com"], expected_max_credits=5,
                         run_state=run_state, root=root)

    assert result["credits_spent"] == 5


# ─── Test: total cap ──────────────────────────────────────────────────────────


def test_total_cap_raises_when_exceeded(tmp_path):
    """
    If total_credits_spent(48) + expected_max_credits(5) > TOTAL_CAP(50), raise.
    subprocess must NOT be called.
    """
    root = _make_root(str(tmp_path), policy_overrides={"total_credits_spent": 48})
    run_state = {"run_credits_spent": 0}

    with mock.patch("firecrawl_client.subprocess.run") as patched_run:
        with pytest.raises(RuntimeError, match="total cap exceeded"):
            fc.call(["map", "https://example.com"], expected_max_credits=5,
                    run_state=run_state, root=root)

    patched_run.assert_not_called()


def test_total_cap_allows_exact_boundary(tmp_path):
    """total_credits_spent(45) + expected_max_credits(5) == TOTAL_CAP(50) is allowed."""
    root = _make_root(str(tmp_path), policy_overrides={"total_credits_spent": 45})
    run_state = {"run_credits_spent": 0}

    side_effects = [
        _status_proc(remaining=160),
        _cmd_proc(stdout="data\n"),
        _status_proc(remaining=155),
    ]
    with mock.patch("firecrawl_client.subprocess.run", side_effect=side_effects):
        result = fc.call(["map", "https://example.com"], expected_max_credits=5,
                         run_state=run_state, root=root)

    assert result["credits_spent"] == 5


# ─── Test: happy path — credits_spent, run_state, policy updates ──────────────


def test_happy_path_credits_spent_and_state_updates(tmp_path):
    """
    Happy path: before=160, after=158 → credits_spent==2.
    run_state and policy are updated correctly.
    """
    root = _make_root(str(tmp_path), policy_overrides={"total_credits_spent": 10})
    run_state = {"run_credits_spent": 3}

    side_effects = [
        _status_proc(remaining=160),   # get_remaining_credits() before
        _cmd_proc(stdout="map output\n"),  # actual firecrawl map call
        _status_proc(remaining=158),   # get_remaining_credits() after
    ]

    with mock.patch("firecrawl_client.subprocess.run", side_effect=side_effects) as patched:
        result = fc.call(["map", "https://example.com"], expected_max_credits=5,
                         run_state=run_state, root=root)

    # Return value
    assert result["returncode"] == 0
    assert result["stdout"] == "map output\n"
    assert result["stderr"] == ""
    assert result["credits_spent"] == 2

    # run_state updated in place: 3 (prior) + 2 (spent) = 5
    assert run_state["run_credits_spent"] == 5

    # Policy persisted: 10 (prior) + 2 (spent) = 12
    with open(os.path.join(root, "firecrawl_policy.json"), encoding="utf-8") as f:
        policy = json.load(f)
    assert policy["total_credits_spent"] == 12

    # subprocess was called 3 times (status before, cmd, status after)
    assert patched.call_count == 3
    # The actual firecrawl command must be the second call.
    # On Windows the command is a shell string; on POSIX it is a list.
    # Either way it must include "firecrawl" and the sub-command "map".
    actual_call = patched.call_args_list[1]
    cmd_arg = actual_call[0][0]
    if isinstance(cmd_arg, list):
        assert cmd_arg[0] == "firecrawl"
        assert "map" in cmd_arg
    else:
        assert "firecrawl" in cmd_arg
        assert "map" in cmd_arg


def test_happy_path_no_credits_spent(tmp_path):
    """If before==after, credits_spent must be 0 (not negative)."""
    root = _make_root(str(tmp_path))
    run_state = {"run_credits_spent": 0}

    side_effects = [
        _status_proc(remaining=160),
        _cmd_proc(stdout="data\n"),
        _status_proc(remaining=160),  # no change
    ]
    with mock.patch("firecrawl_client.subprocess.run", side_effect=side_effects):
        result = fc.call(["map", "https://example.com"], expected_max_credits=2,
                         run_state=run_state, root=root)

    assert result["credits_spent"] == 0
    assert run_state["run_credits_spent"] == 0


def test_happy_path_command_failure_still_records_spend(tmp_path):
    """Even if the firecrawl command exits non-zero, spend is recorded."""
    root = _make_root(str(tmp_path))
    run_state = {"run_credits_spent": 0}

    side_effects = [
        _status_proc(remaining=160),
        _cmd_proc(stdout="", stderr="error\n", returncode=1),
        _status_proc(remaining=159),
    ]
    with mock.patch("firecrawl_client.subprocess.run", side_effect=side_effects):
        result = fc.call(["scrape", "https://example.com"], expected_max_credits=2,
                         run_state=run_state, root=root)

    assert result["returncode"] == 1
    assert result["credits_spent"] == 1
    assert run_state["run_credits_spent"] == 1


# ─── Test: fail-closed on unparseable "before" status ─────────────────────────


def test_call_raises_and_never_runs_command_when_before_status_unparseable(tmp_path):
    """
    If get_remaining_credits() (the "before" read) returns unparseable output,
    call() must raise RuntimeError AND the real firecrawl command must NEVER run
    — only the status read subprocess.run call was made (exactly once total).
    """
    root = _make_root(str(tmp_path))
    run_state = {"run_credits_spent": 0}

    bad_status = mock.MagicMock()
    bad_status.stdout = "Something went horribly wrong\n"
    bad_status.stderr = ""
    bad_status.returncode = 1

    # Side effects: first call is the "before" status read (unparseable).
    # The real firecrawl command must never be reached.
    with mock.patch(
        "firecrawl_client.subprocess.run",
        side_effect=[bad_status],
    ) as patched:
        with pytest.raises(RuntimeError, match="could not parse Credits line"):
            fc.call(["map", "https://example.com"], expected_max_credits=2,
                    run_state=run_state, root=root)

    # Only the status read ran — the real command was never called.
    assert patched.call_count == 1


# ─── Tests: _win_quote ────────────────────────────────────────────────────────


def test_win_quote_flag_passes_through():
    """A CLI flag (starts with '-') is returned unquoted."""
    assert fc._win_quote("--output") == "--output"
    assert fc._win_quote("-v") == "-v"


def test_win_quote_plain_url_is_safe():
    """A URL with only safe chars ([A-Za-z0-9._:/=-]) is returned unquoted."""
    url = "https://example.com/path"
    result = fc._win_quote(url)
    # Must contain the original URL (unquoted or double-quoted — both are safe).
    assert url in result


def test_win_quote_url_with_ampersand_becomes_double_quoted():
    """A URL containing '&' is wrapped in double quotes (CMD treats & literally inside them)."""
    url = "https://example.com/search?q=foo&bar=baz"
    result = fc._win_quote(url)
    assert result == '"' + url + '"'


def test_win_quote_raises_on_percent():
    """An arg containing '%' raises ValueError (cannot be safely quoted in CMD)."""
    with pytest.raises(ValueError, match="unsafe arg for Windows shell"):
        fc._win_quote("https://example.com/path%20here")


def test_win_quote_raises_on_double_quote():
    """An arg containing a double-quote raises ValueError."""
    with pytest.raises(ValueError, match="unsafe arg for Windows shell"):
        fc._win_quote('say "hello"')


def test_win_quote_raises_on_exclamation():
    """An arg containing '!' raises ValueError (delayed expansion in CMD)."""
    with pytest.raises(ValueError, match="unsafe arg for Windows shell"):
        fc._win_quote("hello!world")
