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


if __name__ == "__main__":
    unittest.main()
