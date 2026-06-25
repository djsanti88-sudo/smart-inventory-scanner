#!/usr/bin/env python3
"""
setup_api_schedule.py -- Prints (does NOT execute) the PowerShell commands to
register and remove the "TireApiDailyHarvest" scheduled task.

Run this script, then copy and paste the printed command into an elevated
PowerShell session to register the task.

The owner must run the command; this script intentionally does NOT register it.
"""

import os
import sys

_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_SCRIPTS_DIR)
_BAT_PATH = os.path.join(_SCRIPTS_DIR, "run_api_daily.bat")

TASK_NAME = "TireApiDailyHarvest"
TASK_HOUR = 4   # 4:00 AM daily

def main():
    bat = _BAT_PATH.replace("\\", "\\\\")  # no escaping needed for PS string
    bat_ps = _BAT_PATH  # PowerShell accepts backslashes directly

    register_cmd = f"""Register-ScheduledTask `
  -TaskName "{TASK_NAME}" `
  -Trigger (New-ScheduledTaskTrigger -Daily -At "{TASK_HOUR:02d}:00") `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c "{bat_ps}"') `
  -RunLevel Highest `
  -Force"""

    remove_cmd = f'Unregister-ScheduledTask -TaskName "{TASK_NAME}" -Confirm:$false'

    print("=" * 70)
    print("TIRE API DAILY HARVEST -- Scheduled Task Setup")
    print("=" * 70)
    print()
    print("IMPORTANT: This script does NOT register the task.")
    print("Copy and paste the commands below into an elevated PowerShell session.")
    print()
    print("--- REGISTER (run daily at 4:00 AM) ---")
    print()
    print(register_cmd)
    print()
    print("--- REMOVE ---")
    print()
    print(remove_cmd)
    print()
    print(f"Task name   : {TASK_NAME}")
    print(f"Bat file    : {bat_ps}")
    print(f"Schedule    : Daily at {TASK_HOUR:02d}:00 AM")
    print()
    print("Note: The bat file runs upcitemdb_api_harvest.py which acquires")
    print("harvest.lock, so concurrent manual runs and the scheduled run")
    print("will never write to the corpus simultaneously.")


if __name__ == "__main__":
    main()
