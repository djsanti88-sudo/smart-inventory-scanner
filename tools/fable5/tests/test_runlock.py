from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.fable5.runlock import RunLock, acquire, release


class AcquireReleaseTests(unittest.TestCase):
    def test_acquire_writes_running_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNotNone(lock)
            assert lock is not None
            running_path = root / ".fable5" / "running.json"
            self.assertTrue(running_path.is_file())
            data = json.loads(running_path.read_text(encoding="utf-8"))
            self.assertEqual(data["pid"], os.getpid())
            self.assertEqual(data["mode"], "fast")
            self.assertEqual(data["wall_clock_limit_min"], 15)
            self.assertIn("started_at", data)
            release(lock)

    def test_second_acquire_returns_none_while_held(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNotNone(first)
            second = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNone(second)
            assert first is not None
            release(first)

    def test_release_removes_running_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = acquire(root, mode="fast", limit_minutes=15)
            assert lock is not None
            running_path = root / ".fable5" / "running.json"
            self.assertTrue(running_path.is_file())
            release(lock)
            self.assertFalse(running_path.is_file())
            self.assertFalse((root / ".fable5" / "run.lock").exists())

    def test_acquire_after_release_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = acquire(root, mode="fast", limit_minutes=15)
            assert first is not None
            release(first)
            second = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNotNone(second)
            assert second is not None
            release(second)

    def test_context_manager_acquires_and_releases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            running_path = root / ".fable5" / "running.json"
            with RunLock.acquire_context(root, mode="fast", limit_minutes=15) as lock:
                self.assertIsNotNone(lock)
                self.assertTrue(running_path.is_file())
            self.assertFalse(running_path.is_file())

    def test_context_manager_releases_on_exception(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            running_path = root / ".fable5" / "running.json"
            with self.assertRaises(ValueError):
                with RunLock.acquire_context(root, mode="fast", limit_minutes=15):
                    self.assertTrue(running_path.is_file())
                    raise ValueError("boom")
            self.assertFalse(running_path.is_file())


class StaleLockTests(unittest.TestCase):
    def test_stale_age_breaks_lock_and_reacquires(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            stale_started = (
                datetime.now(timezone.utc) - timedelta(minutes=45)
            ).isoformat()
            (state_dir / "running.json").write_text(
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "started_at": stale_started,
                        "mode": "fast",
                        "wall_clock_limit_min": 15,
                    }
                ),
                encoding="utf-8",
            )
            (state_dir / "run.lock").write_text("", encoding="utf-8")

            lock = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNotNone(lock)
            assert lock is not None
            data = json.loads((state_dir / "running.json").read_text(encoding="utf-8"))
            self.assertEqual(data["mode"], "fast")
            self.assertNotEqual(data["started_at"], stale_started)
            release(lock)

    def test_fresh_lock_within_limit_is_not_broken(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            fresh_started = datetime.now(timezone.utc).isoformat()
            (state_dir / "running.json").write_text(
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "started_at": fresh_started,
                        "mode": "fast",
                        "wall_clock_limit_min": 15,
                    }
                ),
                encoding="utf-8",
            )
            (state_dir / "run.lock").write_text("", encoding="utf-8")

            lock = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNone(lock)

    def test_dead_pid_breaks_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            fresh_started = datetime.now(timezone.utc).isoformat()
            # A PID astronomically unlikely to be alive on this machine.
            dead_pid = 999999
            (state_dir / "running.json").write_text(
                json.dumps(
                    {
                        "pid": dead_pid,
                        "started_at": fresh_started,
                        "mode": "fast",
                        "wall_clock_limit_min": 15,
                    }
                ),
                encoding="utf-8",
            )
            (state_dir / "run.lock").write_text("", encoding="utf-8")

            lock = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNotNone(lock)
            assert lock is not None
            release(lock)

    def test_malformed_running_json_is_treated_as_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            (state_dir / "running.json").write_text("not json", encoding="utf-8")
            (state_dir / "run.lock").write_text("", encoding="utf-8")

            lock = acquire(root, mode="fast", limit_minutes=15)
            self.assertIsNotNone(lock)
            assert lock is not None
            release(lock)


class RunLockDataclassTests(unittest.TestCase):
    def test_lock_records_pid_and_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = acquire(root, mode="pr", limit_minutes=30)
            assert lock is not None
            self.assertEqual(lock.pid, os.getpid())
            self.assertEqual(lock.mode, "pr")
            self.assertEqual(lock.wall_clock_limit_min, 30)
            self.assertEqual(lock.lock_path, root / ".fable5" / "run.lock")
            release(lock)


if __name__ == "__main__":
    unittest.main()
