from __future__ import annotations

import json
import os
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator


STATE_DIRNAME = ".fable5"
LOCK_FILENAME = "run.lock"
RUNNING_FILENAME = "running.json"


@dataclass(frozen=True)
class RunLock:
    root: Path
    pid: int
    mode: str
    started_at: str
    wall_clock_limit_min: int
    lock_path: Path
    running_path: Path

    @staticmethod
    @contextmanager
    def acquire_context(root: Path, mode: str, limit_minutes: int) -> Iterator["RunLock | None"]:
        lock = acquire(root, mode, limit_minutes)
        try:
            yield lock
        finally:
            if lock is not None:
                release(lock)


def _state_dir(root: Path) -> Path:
    return root / STATE_DIRNAME


def _pid_alive(pid: int) -> bool:
    """Check whether a PID is currently running.

    Windows has no signal 0 (the POSIX os.kill(pid, 0) liveness trick does not
    exist here), and psutil is not available inside this stdlib-only tool. We
    shell out to `tasklist /FI "PID eq {pid}"` and check whether it reports the
    PID back. This is slightly slower than a native syscall but requires no
    extra dependency and works identically on every Windows build. On POSIX we
    use the standard os.kill(pid, 0) probe instead.
    """
    if os.name == "nt":
        completed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return str(pid) in completed.stdout
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but is owned by someone else; still alive.
        return True
    except OSError:
        return False
    return True


def _read_running(running_path: Path) -> dict | None:
    try:
        # utf-8-sig tolerates a leading BOM (Windows PowerShell's
        # Set-Content/Out-File default to UTF-8 WITH BOM) as well as plain
        # utf-8, so running.json is readable regardless of which tool wrote it.
        return json.loads(running_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None


def _is_stale(data: dict | None, limit_minutes: int) -> bool:
    if data is None:
        return True
    pid = data.get("pid")
    started_at = data.get("started_at")
    if not isinstance(pid, int) or not isinstance(started_at, str):
        return True
    if not _pid_alive(pid):
        return True
    try:
        started = datetime.fromisoformat(started_at)
    except ValueError:
        return True
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - started
    return age > timedelta(minutes=limit_minutes)


def acquire(root: Path, mode: str, limit_minutes: int) -> RunLock | None:
    state_dir = _state_dir(root)
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / LOCK_FILENAME
    running_path = state_dir / RUNNING_FILENAME

    if lock_path.exists():
        existing = _read_running(running_path)
        if _is_stale(existing, limit_minutes):
            print(
                f"Fable 5: breaking stale run lock (previous pid={existing.get('pid') if existing else '?'})"
            )
            _clear(lock_path, running_path)
        else:
            return None

    started_at = datetime.now(timezone.utc).isoformat()
    pid = os.getpid()
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None
    os.close(lock_fd)
    running_path.write_text(
        json.dumps(
            {
                "pid": pid,
                "started_at": started_at,
                "mode": mode,
                "wall_clock_limit_min": limit_minutes,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return RunLock(
        root=root,
        pid=pid,
        mode=mode,
        started_at=started_at,
        wall_clock_limit_min=limit_minutes,
        lock_path=lock_path,
        running_path=running_path,
    )


def release(lock: RunLock) -> None:
    _clear(lock.lock_path, lock.running_path)


def _clear(lock_path: Path, running_path: Path) -> None:
    for path in (lock_path, running_path):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
