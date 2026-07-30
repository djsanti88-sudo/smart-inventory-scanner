from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


STATE_DIRNAME = ".fable5"
HOOKMARKS_DIRNAME = "hookmarks"
PENDING_PREVIEW_FILENAME = "pending-preview.json"
DEBOUNCE_MINUTES = 30
DAILY_CAP = 4
TRANSCRIPT_TAIL_BYTES = 200 * 1024

_CHECKED_BOX_RE = re.compile(r"^\+.*-\s\[x\]", re.IGNORECASE)
_DIFF_FILE_HEADER_RE = re.compile(r"^\+\+\+ b/(.+)$")
_PREVIEW_URL_RE = re.compile(r"https://[a-z0-9-]+\.vercel\.app")

IGNORED_DIFF_PREFIXES = ("docs/reviews/", "reports/")
PLAN_DIFF_PREFIX = "docs/superpowers/plans/"


def detect_phase_completion(diff_text: str) -> bool:
    """True when an ADDED `- [x]` line appears in a hunk of a plan file.

    Walks the unified diff line by line, tracking which file a hunk belongs to
    via `+++ b/<path>` headers. Files under docs/reviews/ or reports/ never
    count, even if they happen to contain a checkbox-shaped line (the review
    engine writes those, so a checkbox appearing there is our own artifact,
    not an owner-authored plan phase completion).
    """
    current_file: str | None = None
    for line in diff_text.splitlines():
        header_match = _DIFF_FILE_HEADER_RE.match(line)
        if header_match:
            current_file = header_match.group(1).strip()
            continue
        if current_file is None:
            continue
        if any(current_file.startswith(prefix) for prefix in IGNORED_DIFF_PREFIXES):
            continue
        if not current_file.startswith(PLAN_DIFF_PREFIX):
            continue
        if _CHECKED_BOX_RE.match(line):
            return True
    return False


def extract_preview_urls(text: str) -> list[str]:
    """Extract vercel.app preview URLs, deduped, preserving first-seen order."""
    seen: dict[str, None] = {}
    for match in _PREVIEW_URL_RE.finditer(text):
        url = match.group(0)
        if url not in seen:
            seen[url] = None
    return list(seen.keys())


def _read_json(path: Path) -> dict:
    """Read a JSON file written by anything, including PowerShell.

    Windows PowerShell 5.1's Set-Content/Out-File default to UTF-8 WITH a BOM.
    Plain `encoding="utf-8"` leaves that BOM in the decoded string, which then
    fails json.loads. utf-8-sig strips a leading BOM if present and behaves
    identically to utf-8 when absent, so it is safe to use everywhere we read
    JSON state files that might have been touched by a PowerShell hook script.
    """
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _hookmarks_dir(root: Path) -> Path:
    return root / STATE_DIRNAME / HOOKMARKS_DIRNAME


def _plan_marker_path(root: Path, plan_key: str) -> Path:
    digest = hashlib.sha1(plan_key.encode("utf-8")).hexdigest()
    return _hookmarks_dir(root) / f"{digest}.json"


def _daily_marker_path(root: Path, day: str) -> Path:
    return _hookmarks_dir(root) / f"daily-{day}.json"


def should_fire(
    root: Path,
    plan_key: str,
    now_iso: str | None = None,
    *,
    record: bool = True,
) -> bool:
    """Decide whether a hook-triggered review should fire for this plan.

    Two independent gates, both must allow:
    1. Per-plan debounce: a marker file named after sha1(plan_key) must not be
       newer than DEBOUNCE_MINUTES.
    2. Global daily cap: a counter file for today's UTC date must be below
       DAILY_CAP fires.
    On success, both markers are written/incremented and True is returned,
    unless ``record`` is false for a no-write dry-run decision.
    """
    now = datetime.fromisoformat(now_iso) if now_iso else datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    plan_marker = _plan_marker_path(root, plan_key)
    if plan_marker.is_file():
        try:
            data = json.loads(plan_marker.read_text(encoding="utf-8"))
            last_fired = datetime.fromisoformat(data["fired_at"])
            if last_fired.tzinfo is None:
                last_fired = last_fired.replace(tzinfo=timezone.utc)
            if now - last_fired < timedelta(minutes=DEBOUNCE_MINUTES):
                return False
        except (OSError, json.JSONDecodeError, KeyError, ValueError):
            pass

    day = now.strftime("%Y-%m-%d")
    daily_marker = _daily_marker_path(root, day)
    count = 0
    if daily_marker.is_file():
        try:
            count = int(json.loads(daily_marker.read_text(encoding="utf-8")).get("count", 0))
        except (OSError, json.JSONDecodeError, ValueError):
            count = 0
    if count >= DAILY_CAP:
        return False

    if record:
        hookmarks_dir = _hookmarks_dir(root)
        hookmarks_dir.mkdir(parents=True, exist_ok=True)
        plan_marker.write_text(
            json.dumps({"plan_key": plan_key, "fired_at": now.isoformat()}), encoding="utf-8"
        )
        daily_marker.write_text(json.dumps({"date": day, "count": count + 1}), encoding="utf-8")
    return True


def _git_diff(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "diff", *args, "--", "docs/superpowers/plans/*.md"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout if completed.returncode == 0 else ""


def _read_transcript_tail(transcript_path: str | None) -> str:
    if not transcript_path:
        return ""
    path = Path(transcript_path)
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            if size > TRANSCRIPT_TAIL_BYTES:
                handle.seek(size - TRANSCRIPT_TAIL_BYTES)
            raw = handle.read()
        return raw.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _write_pending_previews(root: Path, urls: list[str]) -> None:
    if not urls:
        return
    state_dir = root / STATE_DIRNAME
    state_dir.mkdir(parents=True, exist_ok=True)
    pending_path = state_dir / PENDING_PREVIEW_FILENAME
    existing: list[str] = []
    if pending_path.is_file():
        try:
            existing = list(_read_json(pending_path).get("urls", []))
        except (OSError, json.JSONDecodeError):
            existing = []
    merged: dict[str, None] = {}
    for url in [*existing, *urls]:
        merged[url] = None
    pending_path.write_text(json.dumps({"urls": list(merged.keys())}), encoding="utf-8")


def run_stop_hook(root: Path, stdin_text: str, *, no_write: bool = False) -> int:
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
    except json.JSONDecodeError:
        payload = {}

    diff_text = _git_diff(root) + _git_diff(root, "--cached")
    plan_key = str(root)
    if detect_phase_completion(diff_text) and should_fire(root, plan_key, record=not no_write):
        print("FIRE")

    transcript_tail = _read_transcript_tail(payload.get("transcript_path"))
    urls = extract_preview_urls(transcript_tail)
    if not no_write:
        _write_pending_previews(root, urls)
    return 0


def _format_running_line(running: dict) -> str | None:
    try:
        started = datetime.fromisoformat(running["started_at"])
    except (KeyError, ValueError):
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    minutes = max(0, int((datetime.now(timezone.utc) - started).total_seconds() // 60))
    pid = running.get("pid", "?")
    return f"Fable 5: background review running for {minutes} min (PID {pid}) - kill: taskkill /F /T /PID {pid}"


def run_sessionstart_hook(root: Path) -> int:
    lines: list[str] = []

    latest_path = root / "docs" / "reviews" / "LATEST.json"
    if latest_path.is_file():
        try:
            latest = _read_json(latest_path)
            verdict = latest.get("verdict", "UNKNOWN")
            run_id = latest.get("run_id", "unknown")
            lines.append(f"Fable 5 latest: {verdict} (run {run_id})")
        except (OSError, json.JSONDecodeError):
            pass

    running_path = root / STATE_DIRNAME / "running.json"
    lock_path = root / STATE_DIRNAME / "run.lock"
    if lock_path.exists() and running_path.is_file():
        try:
            running = _read_json(running_path)
            line = _format_running_line(running)
            if line:
                lines.append(line)
        except (OSError, json.JSONDecodeError):
            pass

    pending_path = root / STATE_DIRNAME / PENDING_PREVIEW_FILENAME
    if pending_path.is_file():
        try:
            pending = _read_json(pending_path)
            urls = pending.get("urls", [])
            if urls:
                lines.append(
                    f"Preview stress pending offer: {urls[0]} - offer the owner a stress "
                    "run (autoRunPreviewStress=ask)"
                )
        except (OSError, json.JSONDecodeError):
            pass

    for line in lines[:4]:
        print(line)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fable5-hooks")
    parser.add_argument("--repo", help="Repository root. Defaults to the current directory.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    stop_hook = subparsers.add_parser(
        "stop-hook", help="Handle the Stop hook: detect phase completion, fire."
    )
    stop_hook.add_argument("--repo", help="Repository root. Defaults to the current directory.")
    stop_hook.add_argument(
        "--dry-run", action="store_true", help="Evaluate without writing hook state."
    )
    session_hook = subparsers.add_parser(
        "sessionstart-hook", help="Print up to 4 lines of session-start context."
    )
    session_hook.add_argument("--repo", help="Repository root. Defaults to the current directory.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(args.repo).resolve() if args.repo else Path.cwd()
    if args.command == "stop-hook":
        stdin_text = sys.stdin.read() if not sys.stdin.isatty() else ""
        return run_stop_hook(root, stdin_text, no_write=args.dry_run)
    if args.command == "sessionstart-hook":
        return run_sessionstart_hook(root)
    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
