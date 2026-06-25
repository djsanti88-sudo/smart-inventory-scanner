# Task 7 Report — Credit Firewall

## Files Created

| File | Purpose |
|---|---|
| `firecrawl_policy.json` (harvester root) | Policy caps, kill switch config, persistent spend counter |
| `scripts/firecrawl_client.py` | Credit firewall — load/save policy, get_remaining_credits, kill_switch_active, call() gate |
| `scripts/tests/test_firecrawl_client.py` | 12 TDD tests, all subprocess mocked, 0 real credits spent |

## Credits Number Semantics — CONFIRMED

`firecrawl --status` output (after ANSI strip):

```
  Credits: 160 / 1,000 (16% left this cycle)
```

- **First number (160) = REMAINING credits available to spend.**
- Second number (1,000) = total credits in the billing cycle.
- Confirmed by the label "16% left this cycle": 160 / 1,000 = 16.0%. ✓
- `get_remaining_credits()` returns the REMAINING (first) number.
- This is documented in a code comment in `firecrawl_client.py`.

## Pytest Command and Output

```
cd C:\Users\djsan\inventory\data\tire-knowledge && uv run python -m pytest scripts/tests/test_firecrawl_client.py -v
```

```
============================= test session starts =============================
platform win32 -- Python 3.13.13, pytest-9.0.3, pluggy-1.6.0
collected 12 items

scripts/tests/test_firecrawl_client.py::test_get_remaining_credits_parses_ansi_status PASSED [  8%]
scripts/tests/test_firecrawl_client.py::test_get_remaining_credits_handles_plain_output PASSED [ 16%]
scripts/tests/test_firecrawl_client.py::test_get_remaining_credits_raises_on_unparseable_output PASSED [ 25%]
scripts/tests/test_firecrawl_client.py::test_kill_switch_blocks_call_before_subprocess PASSED [ 33%]
scripts/tests/test_firecrawl_client.py::test_kill_switch_absent_does_not_block PASSED [ 41%]
scripts/tests/test_firecrawl_client.py::test_per_run_cap_raises_when_exceeded PASSED [ 50%]
scripts/tests/test_firecrawl_client.py::test_per_run_cap_allows_exact_boundary PASSED [ 58%]
scripts/tests/test_firecrawl_client.py::test_total_cap_raises_when_exceeded PASSED [ 66%]
scripts/tests/test_firecrawl_client.py::test_total_cap_allows_exact_boundary PASSED [ 75%]
scripts/tests/test_firecrawl_client.py::test_happy_path_credits_spent_and_state_updates PASSED [ 83%]
scripts/tests/test_firecrawl_client.py::test_happy_path_no_credits_spent PASSED [ 91%]
scripts/tests/test_firecrawl_client.py::test_happy_path_command_failure_still_records_spend PASSED [100%]

============================= 12 passed in 0.07s ==============================
```

## Real get_remaining_credits() Result

```
uv run python -c "... fc.get_remaining_credits() ..."
remaining credits = 160
```

Matches `firecrawl --status` output exactly (160 / 1,000 remaining).

## Credit Spend Confirmation

- **Zero scrape/map/crawl/search credits were spent.** Only `firecrawl --status` (read-only, 0 credits) was invoked live.
- All `call()` tests mock `subprocess.run` — no real Firecrawl CLI commands ran.
- Policy file `firecrawl_policy.json` shows `"total_credits_spent": 0`.

## Implementation Notes

- **Windows .cmd quirk:** `firecrawl` is an npm-installed `.cmd` script. `subprocess.run` with a bare list fails on Windows with `FileNotFoundError`. The client detects `sys.platform == "win32"` and uses `shell=True` with a string command on Windows, and a list on POSIX. Tests mock `subprocess.run` at the module level so the shell vs. list distinction is transparent to tests.
- **ANSI stripping:** A regex strips all ANSI escape sequences before the Credits regex runs, making parsing robust to color output changes.
- **Guard order in call():** kill switch → per-run cap → total cap → get_remaining_credits() before → subprocess → get_remaining_credits() after → record spend. This order ensures no subprocess call ever occurs when any guard fails.
- **No spend when before==after:** `max(0, before - after)` prevents negative credits_spent if credits somehow increase (e.g., billing reset mid-run).

---

## Fix Round 1

### Fix 1 — Windows command quoting (Important)

**Problem:** The Windows branch of `call()` used `shlex.quote()`, which produces POSIX single-quotes (`'arg'`) that CMD does not honour. A URL containing `&`, `|`, `^`, `<`, `>`, `(`, `)` could break the command or inject into the shell.

**Solution:** Added `_win_quote(arg: str) -> str` helper in `firecrawl_client.py`:

- CLI flags (start with `-`) or args containing only `[A-Za-z0-9._:/=-]` are returned unquoted.
- Args containing `"`, `%`, `!`, or any control/newline char raise `ValueError` — these cannot be safely neutralised in CMD double-quotes; fail closed rather than risk injection.
- All other args are wrapped in CMD double-quotes so metacharacters like `& | ^ < > ( )` are treated as literals.

The Windows branch of `call()` now builds: `"firecrawl " + " ".join(_win_quote(a) for a in cmd_args)`.

The POSIX branch (list-based, no shell) is unchanged.

Also added `import unicodedata` (used in `_win_quote` to detect control characters).

**Files changed:**
- `scripts/firecrawl_client.py` — added `_win_quote`, `_WIN_SAFE_RE`, `_WIN_UNSAFE_CHARS`; replaced `shlex.quote` in Windows branch; added `import unicodedata`.

### Fix 2 — Fail-closed test for unparseable "before" status (Minor)

**Problem:** No test verified that an unparseable `firecrawl --status` response before the real call would (a) raise `RuntimeError` and (b) never run the actual firecrawl command.

**Solution:** Added `test_call_raises_and_never_runs_command_when_before_status_unparseable` which mocks `subprocess.run` with a single unparseable status response and asserts `RuntimeError` is raised and `subprocess.run` was called exactly once (status read only, no command).

Also added six `_win_quote` unit tests:
- `test_win_quote_flag_passes_through` — flags returned unquoted.
- `test_win_quote_plain_url_is_safe` — safe-char URL returned (un)quoted safely.
- `test_win_quote_url_with_ampersand_becomes_double_quoted` — `&` in URL triggers double-quoting.
- `test_win_quote_raises_on_percent` — `%` raises `ValueError`.
- `test_win_quote_raises_on_double_quote` — `"` raises `ValueError`.
- `test_win_quote_raises_on_exclamation` — `!` raises `ValueError`.

**Files changed:**
- `scripts/tests/test_firecrawl_client.py` — added 7 new tests (1 fail-closed + 6 `_win_quote`).

### Pytest Command and Output

```
cd C:\Users\djsan\inventory\data\tire-knowledge && uv run python -m pytest scripts/tests/test_firecrawl_client.py -v
```

```
============================= test session starts =============================
platform win32 -- Python 3.13.13, pytest-9.0.3, pluggy-1.6.0 -- ...
collected 19 items

scripts/tests/test_firecrawl_client.py::test_get_remaining_credits_parses_ansi_status PASSED [  5%]
scripts/tests/test_firecrawl_client.py::test_get_remaining_credits_handles_plain_output PASSED [ 10%]
scripts/tests/test_firecrawl_client.py::test_get_remaining_credits_raises_on_unparseable_output PASSED [ 15%]
scripts/tests/test_firecrawl_client.py::test_kill_switch_blocks_call_before_subprocess PASSED [ 21%]
scripts/tests/test_firecrawl_client.py::test_kill_switch_absent_does_not_block PASSED [ 26%]
scripts/tests/test_firecrawl_client.py::test_per_run_cap_raises_when_exceeded PASSED [ 31%]
scripts/tests/test_firecrawl_client.py::test_per_run_cap_allows_exact_boundary PASSED [ 36%]
scripts/tests/test_firecrawl_client.py::test_total_cap_raises_when_exceeded PASSED [ 42%]
scripts/tests/test_firecrawl_client.py::test_total_cap_allows_exact_boundary PASSED [ 47%]
scripts/tests/test_firecrawl_client.py::test_happy_path_credits_spent_and_state_updates PASSED [ 52%]
scripts/tests/test_firecrawl_client.py::test_happy_path_no_credits_spent PASSED [ 57%]
scripts/tests/test_firecrawl_client.py::test_happy_path_command_failure_still_records_spend PASSED [ 63%]
scripts/tests/test_firecrawl_client.py::test_call_raises_and_never_runs_command_when_before_status_unparseable PASSED [ 68%]
scripts/tests/test_firecrawl_client.py::test_win_quote_flag_passes_through PASSED [ 73%]
scripts/tests/test_firecrawl_client.py::test_win_quote_plain_url_is_safe PASSED [ 78%]
scripts/tests/test_firecrawl_client.py::test_win_quote_url_with_ampersand_becomes_double_quoted PASSED [ 84%]
scripts/tests/test_firecrawl_client.py::test_win_quote_raises_on_percent PASSED [ 89%]
scripts/tests/test_firecrawl_client.py::test_win_quote_raises_on_double_quote PASSED [ 94%]
scripts/tests/test_firecrawl_client.py::test_win_quote_raises_on_exclamation PASSED [100%]

============================= 19 passed in 0.07s ==============================
```

### Live `get_remaining_credits()` Result

```
uv run python -c "import sys; sys.path.insert(0,'scripts'); import firecrawl_client as fc; print('remaining =', fc.get_remaining_credits())"
remaining = 160
```

Unchanged from task 7 baseline (160 / 1,000). No regression.

### Credit Spend Confirmation

- **Zero scrape/map/crawl/search credits spent.** Only `firecrawl --status` (read-only, free) was invoked live.
- All `call()` tests mock `subprocess.run` — no real Firecrawl CLI commands ran.
- Policy file `firecrawl_policy.json` shows `"total_credits_spent": 0`.
