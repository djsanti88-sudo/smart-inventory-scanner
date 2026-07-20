from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from tools.fable5.models import CapabilityInventory, CheckResult, RunReport
from tools.fable5.report import render_markdown, write_report
from tools.fable5.verdict import UNTRUSTED_BANNER


def make_result(
    check_id: str,
    status: str,
    reason: str = "",
    cached: bool = False,
    blocking: bool = True,
    output_tail: str = "",
) -> CheckResult:
    return CheckResult(
        check_id=check_id,
        description=f"Check {check_id}",
        status=status,
        blocking=blocking,
        command=["python", "--version"],
        started_at=datetime.now(timezone.utc).isoformat(),
        duration_seconds=1.5,
        reason=reason,
        output_tail=output_tail,
        cached=cached,
    )


def make_report(results: list[CheckResult]) -> RunReport:
    return RunReport(
        schema_version=1,
        run_id="20260101T000000Z-fast",
        project="Test Project",
        gate="fast",
        started_at=datetime.now(timezone.utc).isoformat(),
        finished_at=datetime.now(timezone.utc).isoformat(),
        duration_seconds=12.0,
        repository="/repo",
        git_head="deadbeef1234",
        workspace_fingerprint="fp",
        changed_files=["a.py"],
        selected_agents=[],
        capabilities=CapabilityInventory(
            tools={}, agents=(), skills=(), plugins=(), package_scripts=()
        ),
        results=results,
    )


class ReportLedgerTests(unittest.TestCase):
    def test_markdown_lists_every_result_in_checked_table(self) -> None:
        results = [
            make_result("a", "passed"),
            make_result("b", "failed", reason="broke"),
            make_result("c", "warning", reason="careful"),
            make_result("d", "skipped", reason="no changed files"),
            make_result("e", "planned", reason="dry run"),
            make_result("f", "passed", reason="Reused matching successful evidence", cached=True),
        ]
        markdown = render_markdown(make_report(results))
        self.assertIn("What was checked", markdown)
        for result in results:
            self.assertIn(result.check_id, markdown)

    def test_cached_status_labeled_in_ledger(self) -> None:
        results = [
            make_result("f", "passed", reason="Reused matching successful evidence", cached=True)
        ]
        markdown = render_markdown(make_report(results))
        self.assertIn("cached", markdown.lower())

    def test_docs_staleness_and_expert_rows_included(self) -> None:
        results = [
            make_result("docs-staleness:README.md", "warning", reason="dead link"),
            make_result("experts-tier", "skipped", reason="risk score below threshold"),
        ]
        markdown = render_markdown(make_report(results))
        self.assertIn("docs-staleness:README.md", markdown)
        self.assertIn("experts-tier", markdown)


class FixPacketTests(unittest.TestCase):
    def test_fix_packet_written_when_failed_or_warning(self) -> None:
        results = [
            make_result("a", "passed"),
            make_result("b", "failed", reason="build broke"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "reports" / "fable5" / "run"
            write_report(make_report(results), report_dir, root)
            fix_packet = report_dir / "fix-packet.md"
            self.assertTrue(fix_packet.exists())
            text = fix_packet.read_text(encoding="utf-8")
            self.assertIn(UNTRUSTED_BANNER, text)
            self.assertIn("b", text)
            self.assertIn("build broke", text)
            self.assertIn("```", text)

    def test_fix_packet_not_written_when_all_passed(self) -> None:
        results = [make_result("a", "passed")]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "reports" / "fable5" / "run"
            write_report(make_report(results), report_dir, root)
            fix_packet = report_dir / "fix-packet.md"
            self.assertFalse(fix_packet.exists())

    def test_fix_packet_written_for_warning_only(self) -> None:
        results = [make_result("a", "warning", reason="careful")]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "reports" / "fable5" / "run"
            write_report(make_report(results), report_dir, root)
            fix_packet = report_dir / "fix-packet.md"
            self.assertTrue(fix_packet.exists())

    def test_secrets_redacted_in_fix_packet_and_report(self) -> None:
        results = [
            make_result(
                "b",
                "failed",
                reason="leaked api_key: sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN in output",
            )
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "reports" / "fable5" / "run"
            write_report(make_report(results), report_dir, root)
            fix_packet_text = (report_dir / "fix-packet.md").read_text(encoding="utf-8")
            report_text = (report_dir / "report.md").read_text(encoding="utf-8")
            self.assertNotIn(
                "sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN", fix_packet_text
            )
            self.assertNotIn(
                "sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN", report_text
            )
            self.assertIn("<redacted>", fix_packet_text)

    def test_secrets_redacted_in_every_report_artifact(self) -> None:
        secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
        results = [
            make_result(
                "secret-check",
                "failed",
                reason=f"reason exposed {secret}",
                output_tail=f"output exposed {secret}",
            )
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "reports" / "fable5" / "run"
            write_report(make_report(results), report_dir, root)

            for artifact in ("run.json", "report.html", "expert-packet.md"):
                text = (report_dir / artifact).read_text(encoding="utf-8")
                with self.subTest(artifact=artifact):
                    self.assertNotIn(secret, text)
                    self.assertIn("<redacted>", text)


if __name__ == "__main__":
    unittest.main()
