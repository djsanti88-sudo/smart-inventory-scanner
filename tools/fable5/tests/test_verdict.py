from __future__ import annotations

import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.fable5.models import CheckResult, PlanReview
from tools.fable5.verdict import (
    decide,
    exit_code,
    prune_old_runs,
    redact_secrets,
    write_latest,
)


def make_result(
    check_id: str = "check",
    status: str = "passed",
    blocking: bool = True,
    reason: str = "",
) -> CheckResult:
    return CheckResult(
        check_id=check_id,
        description="A check",
        status=status,
        blocking=blocking,
        command=["python", "--version"],
        started_at=datetime.now(timezone.utc).isoformat(),
        reason=reason,
    )


class DecideTests(unittest.TestCase):
    def test_all_passed_is_pass(self) -> None:
        results = [make_result("a", "passed"), make_result("b", "passed")]
        verdict = decide(results, None)
        self.assertEqual(verdict.status, "PASS")
        self.assertEqual(verdict.reasons, ())
        self.assertEqual(verdict.top_blockers, ())

    def test_blocking_failed_is_block(self) -> None:
        results = [
            make_result("a", "passed"),
            make_result("b", "failed", blocking=True, reason="build broke"),
        ]
        verdict = decide(results, None)
        self.assertEqual(verdict.status, "BLOCK")
        self.assertIn("b", " ".join(verdict.reasons))
        self.assertIn("build broke", " ".join(verdict.reasons))

    def test_non_blocking_failed_is_pass(self) -> None:
        results = [make_result("a", "failed", blocking=False, reason="warned")]
        verdict = decide(results, None)
        self.assertEqual(verdict.status, "PASS")

    def test_plan_blocked_is_block(self) -> None:
        plan_review = PlanReview(
            path="plan.md",
            score=10,
            verdict="blocked",
            missing_proofs=["Proof: run npm test", "Proof: run npm build"],
        )
        verdict = decide([make_result("a", "passed")], plan_review)
        self.assertEqual(verdict.status, "BLOCK")
        joined = " ".join(verdict.reasons)
        self.assertIn("run npm test", joined)
        self.assertIn("run npm build", joined)

    def test_plan_ready_does_not_block(self) -> None:
        plan_review = PlanReview(path="plan.md", score=90, verdict="ready")
        verdict = decide([make_result("a", "passed")], plan_review)
        self.assertEqual(verdict.status, "PASS")

    def test_top_blockers_capped_at_three(self) -> None:
        results = [
            make_result("a", "failed", blocking=True, reason="reason a"),
            make_result("b", "failed", blocking=True, reason="reason b"),
            make_result("c", "failed", blocking=True, reason="reason c"),
            make_result("d", "failed", blocking=True, reason="reason d"),
        ]
        verdict = decide(results, None)
        self.assertEqual(len(verdict.top_blockers), 3)
        self.assertEqual(len(verdict.reasons), 4)


class ExitCodeTests(unittest.TestCase):
    def test_pass_is_zero(self) -> None:
        verdict = decide([make_result("a", "passed")], None)
        self.assertEqual(exit_code(verdict), 0)

    def test_block_is_two(self) -> None:
        verdict = decide([make_result("a", "failed", blocking=True, reason="x")], None)
        self.assertEqual(exit_code(verdict), 2)


class RedactSecretsTests(unittest.TestCase):
    def test_bearer_token_redacted(self) -> None:
        text = "Authorization: Bearer abcdefghijklmnopqrstuvwx1234567890ABCDEF"
        redacted = redact_secrets(text)
        self.assertNotIn("abcdefghijklmnopqrstuvwx1234567890ABCDEF", redacted)
        self.assertIn("<redacted>", redacted)

    def test_api_key_redacted(self) -> None:
        text = "api_key: sk_live_abcdefghijklmnopqrstuvwxyz1234567890ABCD"
        redacted = redact_secrets(text)
        self.assertIn("<redacted>", redacted)

    def test_openai_style_sk_prefix_redacted(self) -> None:
        text = "found leaked value sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN in logs"
        redacted = redact_secrets(text)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN", redacted)
        self.assertIn("<redacted>", redacted)

    def test_akia_prefix_redacted(self) -> None:
        text = "aws key AKIAABCDEFGHIJKLMNOP leaked in commit"
        redacted = redact_secrets(text)
        self.assertNotIn("AKIAABCDEFGHIJKLMNOP", redacted)
        self.assertIn("<redacted>", redacted)

    def test_private_key_block_redacted(self) -> None:
        text = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEpAIBAAKCAQEA1234567890abcdef\n"
            "-----END RSA PRIVATE KEY-----"
        )
        redacted = redact_secrets(text)
        self.assertNotIn("MIIEpAIBAAKCAQEA1234567890abcdef", redacted)
        self.assertIn("<redacted>", redacted)

    def test_password_redacted(self) -> None:
        text = "password=Sup3rSecretValueThatIsLong123456789"
        redacted = redact_secrets(text)
        self.assertIn("<redacted>", redacted)

    def test_no_false_positive_on_plain_prose(self) -> None:
        text = (
            "The check ran successfully and the report was written to "
            "reports/fable5/20260101T000000Z-fast/report.md without incident."
        )
        self.assertEqual(redact_secrets(text), text)

    def test_no_false_positive_on_file_paths(self) -> None:
        text = (
            "See tools/fable5/verdict.py and docs/reviews/LATEST.json for details, "
            "also C:\\Users\\djsan\\inventory\\tools\\fable5\\cli.py is relevant."
        )
        self.assertEqual(redact_secrets(text), text)

    def test_short_hex_like_ids_not_redacted(self) -> None:
        text = "git head abc123def456 changed 12 files"
        self.assertEqual(redact_secrets(text), text)


class WriteLatestTests(unittest.TestCase):
    def test_writes_atomic_file_with_expected_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verdict = decide([make_result("a", "passed")], None)
            started_at = datetime.now(timezone.utc).isoformat()
            ok = write_latest(
                root=root,
                verdict=verdict,
                run_id="20260101T000000Z-fast",
                report_dir=root / "reports" / "fable5" / "20260101T000000Z-fast",
                run_started_at=started_at,
                cost_note="subscription; true spend = provider console",
            )
            self.assertTrue(ok)
            latest_path = root / "docs" / "reviews" / "LATEST.json"
            self.assertTrue(latest_path.exists())
            self.assertFalse((root / "docs" / "reviews" / "LATEST.json.tmp").exists())
            data = json.loads(latest_path.read_text(encoding="utf-8"))
            self.assertEqual(data["verdict"], "PASS")
            self.assertEqual(data["run_id"], "20260101T000000Z-fast")
            self.assertEqual(data["generated_at"], started_at)
            self.assertEqual(
                data["cost_note"], "subscription; true spend = provider console"
            )
            self.assertIn("report.md", data["report"])
            self.assertNotIn("\\", data["report"])
            self.assertEqual(data["top_blockers"], [])

    def test_stale_guard_refuses_older_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            latest_dir = root / "docs" / "reviews"
            latest_dir.mkdir(parents=True)
            newer = datetime.now(timezone.utc).isoformat()
            existing = {
                "verdict": "PASS",
                "run_id": "future-run",
                "report": "reports/fable5/future-run/report.md",
                "top_blockers": [],
                "generated_at": newer,
                "cost_note": "subscription; true spend = provider console",
            }
            (latest_dir / "LATEST.json").write_text(
                json.dumps(existing), encoding="utf-8"
            )

            verdict = decide([make_result("a", "passed")], None)
            older = (
                datetime.now(timezone.utc) - timedelta(hours=1)
            ).isoformat()
            ok = write_latest(
                root=root,
                verdict=verdict,
                run_id="older-run",
                report_dir=root / "reports" / "fable5" / "older-run",
                run_started_at=older,
                cost_note="subscription; true spend = provider console",
            )
            self.assertFalse(ok)
            data = json.loads((latest_dir / "LATEST.json").read_text(encoding="utf-8"))
            self.assertEqual(data["run_id"], "future-run")

    def test_newer_run_replaces_existing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            latest_dir = root / "docs" / "reviews"
            latest_dir.mkdir(parents=True)
            older = (
                datetime.now(timezone.utc) - timedelta(hours=1)
            ).isoformat()
            existing = {
                "verdict": "PASS",
                "run_id": "old-run",
                "report": "reports/fable5/old-run/report.md",
                "top_blockers": [],
                "generated_at": older,
                "cost_note": "subscription; true spend = provider console",
            }
            (latest_dir / "LATEST.json").write_text(
                json.dumps(existing), encoding="utf-8"
            )

            verdict = decide([make_result("a", "passed")], None)
            newer = datetime.now(timezone.utc).isoformat()
            ok = write_latest(
                root=root,
                verdict=verdict,
                run_id="new-run",
                report_dir=root / "reports" / "fable5" / "new-run",
                run_started_at=newer,
                cost_note="subscription; true spend = provider console",
            )
            self.assertTrue(ok)
            data = json.loads((latest_dir / "LATEST.json").read_text(encoding="utf-8"))
            self.assertEqual(data["run_id"], "new-run")

    def test_creates_missing_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verdict = decide([make_result("a", "passed")], None)
            started_at = datetime.now(timezone.utc).isoformat()
            ok = write_latest(
                root=root,
                verdict=verdict,
                run_id="run",
                report_dir=root / "reports" / "fable5" / "run",
                run_started_at=started_at,
                cost_note="subscription; true spend = provider console",
            )
            self.assertTrue(ok)
            self.assertTrue((root / "docs" / "reviews").is_dir())

    def test_malformed_existing_latest_does_not_block_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            latest_dir = root / "docs" / "reviews"
            latest_dir.mkdir(parents=True)
            (latest_dir / "LATEST.json").write_text("not json", encoding="utf-8")

            verdict = decide([make_result("a", "passed")], None)
            started_at = datetime.now(timezone.utc).isoformat()
            ok = write_latest(
                root=root,
                verdict=verdict,
                run_id="run",
                report_dir=root / "reports" / "fable5" / "run",
                run_started_at=started_at,
                cost_note="subscription; true spend = provider console",
            )
            self.assertTrue(ok)


class PruneOldRunsTests(unittest.TestCase):
    def _touch_dir(self, path: Path, age_days: float) -> None:
        path.mkdir(parents=True, exist_ok=True)
        (path / "run.json").write_text("{}", encoding="utf-8")
        stamp = time.time() - age_days * 86400
        import os

        os.utime(path, (stamp, stamp))

    def test_old_run_pruned_new_run_kept(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            reports_root = Path(temporary) / "reports" / "fable5"
            old_run = reports_root / "old-run"
            new_run = reports_root / "new-run"
            self._touch_dir(old_run, age_days=20)
            self._touch_dir(new_run, age_days=1)

            pruned = prune_old_runs(reports_root, keep_days=14)

            self.assertIn("old-run", pruned)
            self.assertNotIn("new-run", pruned)
            self.assertFalse(old_run.exists())
            self.assertTrue(new_run.exists())

    def test_missing_reports_root_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            reports_root = Path(temporary) / "reports" / "fable5"
            pruned = prune_old_runs(reports_root, keep_days=14)
            self.assertEqual(pruned, [])

    def test_never_touches_paths_outside_reports_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reports_root = root / "reports" / "fable5"
            reports_root.mkdir(parents=True)
            outside = root / "outside-run"
            self._touch_dir(outside, age_days=30)

            pruned = prune_old_runs(reports_root, keep_days=14)

            self.assertEqual(pruned, [])
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
