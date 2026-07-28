from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools.fable5.cache import EvidenceCache
from tools.fable5.config import FableConfig
from tools.fable5.models import CheckSpec
from tools.fable5.scheduler import SafetyPolicy, run_checks


def make_config(checks: tuple[CheckSpec, ...]) -> FableConfig:
    return FableConfig(
        project_name="test",
        reports_dir="reports",
        cache_db=".cache/db",
        agents_dir=".claude/agents",
        light_workers=2,
        heavy_workers=1,
        browser_workers=1,
        allowed_executables=frozenset({"python"}),
        checks=checks,
        routes=(),
    )


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_dry_run_plans_allowed_command(self) -> None:
        spec = CheckSpec(
            check_id="python",
            description="version",
            command=("python", "--version"),
            gates=frozenset({"fast"}),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            results = await run_checks(
                root=root,
                config=make_config((spec,)),
                gate="fast",
                report_dir=root / "report",
                changed_files=[],
                workspace_key="abc",
                cache=EvidenceCache(root / "cache.sqlite3", enabled=False),
                policy=SafetyPolicy(),
                dry_run=True,
                callback=lambda _: None,
            )
        self.assertEqual(results[0].status, "planned")

    async def test_network_check_is_blocked_by_default(self) -> None:
        spec = CheckSpec(
            check_id="network",
            description="network",
            command=("python", "--version"),
            gates=frozenset({"fast"}),
            network=True,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            results = await run_checks(
                root=root,
                config=make_config((spec,)),
                gate="fast",
                report_dir=root / "report",
                changed_files=[],
                workspace_key="abc",
                cache=EvidenceCache(root / "cache.sqlite3", enabled=False),
                policy=SafetyPolicy(),
                callback=lambda _: None,
            )
        self.assertEqual(results[0].status, "blocked")
        self.assertIn("network", results[0].reason)

    async def test_failed_dependency_skips_dependent_check(self) -> None:
        first = CheckSpec(
            check_id="first",
            description="fails",
            command=("python", "-c", "raise SystemExit(3)"),
            gates=frozenset({"fast"}),
        )
        second = CheckSpec(
            check_id="second",
            description="dependent",
            command=("python", "--version"),
            gates=frozenset({"fast"}),
            depends_on=("first",),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            results = await run_checks(
                root=root,
                config=make_config((first, second)),
                gate="fast",
                report_dir=root / "report",
                changed_files=[],
                workspace_key="abc",
                cache=EvidenceCache(root / "cache.sqlite3", enabled=False),
                policy=SafetyPolicy(),
                callback=lambda _: None,
            )
        statuses = {result.check_id: result.status for result in results}
        self.assertEqual(statuses, {"first": "failed", "second": "skipped"})

    async def test_deterministic_log_redacts_secret_output(self) -> None:
        secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
        spec = CheckSpec(
            check_id="secret-output",
            description="prints a fixture secret",
            command=("python", "-c", f"print({secret!r})"),
            gates=frozenset({"fast"}),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "report"
            await run_checks(
                root=root,
                config=make_config((spec,)),
                gate="fast",
                report_dir=report_dir,
                changed_files=[],
                workspace_key="abc",
                cache=EvidenceCache(root / "cache.sqlite3", enabled=False),
                policy=SafetyPolicy(),
                callback=lambda _: None,
            )

            log_text = (report_dir / "logs" / "secret-output.log").read_text(
                encoding="utf-8"
            )
        self.assertNotIn(secret, log_text)
        self.assertIn("<redacted>", log_text)

    async def _run(self, spec: CheckSpec, root: Path, report_dir: Path | None = None):
        return await run_checks(
            root=root,
            config=make_config((spec,)),
            gate="fast",
            report_dir=report_dir or (root / "report"),
            changed_files=[],
            workspace_key="abc",
            cache=EvidenceCache(root / "cache.sqlite3", enabled=False),
            policy=SafetyPolicy(),
            callback=lambda _: None,
        )

    # A command that fails on its first run and passes on the second, keyed by a
    # marker file in cwd - simulates a transient failure (e.g. tsc reading a tree
    # while another process edits it).
    _FLAKY = (
        "import os, sys\n"
        "m = os.path.join(os.getcwd(), '.rc-marker')\n"
        "if os.path.exists(m):\n"
        "    sys.exit(0)\n"
        "open(m, 'w').close()\n"
        "sys.exit(1)\n"
    )

    async def test_transient_blocking_failure_recovers_on_reconfirm(self) -> None:
        spec = CheckSpec(
            check_id="flaky",
            description="fails once then passes",
            command=("python", "-c", self._FLAKY),
            gates=frozenset({"fast"}),
            blocking=True,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            results = await self._run(spec, root)
        result = results[0]
        self.assertEqual(result.status, "passed")
        self.assertIn("reconfirm", (result.reason or "").lower())

    async def test_persistent_blocking_failure_stays_failed_after_reconfirm(self) -> None:
        spec = CheckSpec(
            check_id="broken",
            description="always fails",
            command=("python", "-c", "import sys; sys.exit(1)"),
            gates=frozenset({"fast"}),
            blocking=True,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            results = await self._run(spec, root)
        self.assertEqual(results[0].status, "failed")

    async def test_non_blocking_failure_is_not_reconfirmed(self) -> None:
        spec = CheckSpec(
            check_id="nonblock",
            description="non-blocking flaky",
            command=("python", "-c", self._FLAKY),
            gates=frozenset({"fast"}),
            blocking=False,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "report"
            results = await self._run(spec, root, report_dir)
            self.assertFalse((report_dir / "logs" / "nonblock.reconfirm.log").exists())
        self.assertEqual(results[0].status, "warning")
        self.assertNotIn("reconfirm", (results[0].reason or "").lower())

    async def test_timeout_failure_is_not_reconfirmed(self) -> None:
        spec = CheckSpec(
            check_id="slow",
            description="hangs",
            command=("python", "-c", "import time; time.sleep(10)"),
            gates=frozenset({"fast"}),
            blocking=True,
            timeout_seconds=1,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "report"
            results = await self._run(spec, root, report_dir)
            self.assertFalse((report_dir / "logs" / "slow.reconfirm.log").exists())
        self.assertEqual(results[0].status, "failed")
        self.assertIn("Timed out", results[0].reason or "")


if __name__ == "__main__":
    unittest.main()
