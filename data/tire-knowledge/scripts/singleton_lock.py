"""Single-instance guard for the harvest + enricher.

Why: two concurrent harvest processes once poisoned the ledger (duplicate barcodes / phantom
counts). This guarantees only ONE instance of a given job runs at a time, so the 24/7 watchdog can
safely restart a job without ever creating a duplicate. A STALE lock (the recorded PID is no longer
alive, e.g. after a crash) is reclaimed automatically, so a restart after a crash still works.
"""
import os
import subprocess
import sys


def _alive(pid: int) -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        return str(pid) in out
    except Exception:
        return True  # fail safe: if we can't tell, assume alive so we never double-launch


def acquire_or_exit(name: str, outputs_dir: str) -> None:
    """Exit(0) immediately if another live instance of `name` holds the lock; otherwise claim it."""
    lock = os.path.join(outputs_dir, f"{name}.lock")
    if os.path.exists(lock):
        try:
            old = int((open(lock).read().strip() or "0"))
        except Exception:
            old = 0
        if old and old != os.getpid() and _alive(old):
            print(f"[{name}] another instance (pid {old}) is already running; exiting.", flush=True)
            sys.exit(0)
    try:
        os.makedirs(outputs_dir, exist_ok=True)
        with open(lock, "w") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
