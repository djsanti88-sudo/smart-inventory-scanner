"""24/7 watchdog: keeps the Tirelibrary harvest + Gemini enricher alive.

Every CHECK_SECS it checks whether each job's process exists; if not, it restarts it. The jobs'
own singleton_lock guard makes duplicates impossible, so a restart is always safe. Restarts + status
are logged to outputs/watchdog.log. Launch DETACHED (Start-Process -WindowStyle Hidden) so it survives
the terminal session. NOTE: a machine reboot stops it - re-launch after reboot (or register a logon
Scheduled Task) for reboot-resilience.
"""
import datetime
import os
import subprocess
import sys
import time

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_SCRIPTS)  # tire-knowledge/
PY = sys.executable or r"C:\Users\djsan\AppData\Local\Programs\Python\Python313\python.exe"
LOG = os.path.join(ROOT, "outputs", "watchdog.log")
CHECK_SECS = 90

# Harvest is COMPLETE (all 665 brands processed) - removed so the watchdog stops re-poking a finished
# job. Only the enricher (still working the ~150k no-barcode pile) needs keeping alive now.
TARGETS = {
    "barcode_enrich.py": [PY, "scripts/barcode_enrich.py"],
}


def _count(name: str) -> int:
    ps = (
        "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
        f"Where-Object {{ $_.CommandLine -match '{name}' }} | Measure-Object).Count"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return int(out) if out.isdigit() else 0
    except Exception:
        return 1  # fail safe: if we can't tell, assume it's running (never relaunch blindly)


def _log(msg: str) -> None:
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)


def main() -> None:
    from singleton_lock import acquire_or_exit
    acquire_or_exit("watchdog", os.path.join(ROOT, "outputs"))  # only one watchdog
    _log("watchdog started")
    while True:
        for name, cmd in TARGETS.items():
            if _count(name) == 0:
                out = open(os.path.join(ROOT, "outputs", f"{name}.out.log"), "a", encoding="utf-8")
                subprocess.Popen(cmd, cwd=ROOT, stdout=out, stderr=out)
                _log(f"RESTARTED {name}")
                time.sleep(12)  # let it boot + claim its lock before the next scan
        time.sleep(CHECK_SECS)


if __name__ == "__main__":
    main()
