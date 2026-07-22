from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.fable5.hook_support import (
    detect_phase_completion,
    extract_preview_urls,
    should_fire,
)


PLAN_DIFF_CHECKED = """\
diff --git a/docs/superpowers/plans/2026-07-19-master-plan.md b/docs/superpowers/plans/2026-07-19-master-plan.md
index 1111111..2222222 100644
--- a/docs/superpowers/plans/2026-07-19-master-plan.md
+++ b/docs/superpowers/plans/2026-07-19-master-plan.md
@@ -10,7 +10,7 @@
-- [ ] Ship phase 1
+- [x] Ship phase 1
"""

PLAN_DIFF_UNCHECKED = """\
diff --git a/docs/superpowers/plans/2026-07-19-master-plan.md b/docs/superpowers/plans/2026-07-19-master-plan.md
index 1111111..2222222 100644
--- a/docs/superpowers/plans/2026-07-19-master-plan.md
+++ b/docs/superpowers/plans/2026-07-19-master-plan.md
@@ -10,7 +10,7 @@
 Some context line unrelated to checkboxes.
+Another plain added line, no checkbox here.
"""

REVIEWS_DIFF_CHECKED = """\
diff --git a/docs/reviews/LATEST.json b/docs/reviews/LATEST.json
index 1111111..2222222 100644
--- a/docs/reviews/LATEST.json
+++ b/docs/reviews/LATEST.json
@@ -1,3 +1,3 @@
-- [ ] should never matter here
+- [x] should never matter here
"""

REPORTS_DIFF_CHECKED = """\
diff --git a/reports/fable5/run/report.md b/reports/fable5/run/report.md
index 1111111..2222222 100644
--- a/reports/fable5/run/report.md
+++ b/reports/fable5/run/report.md
@@ -1,3 +1,3 @@
-- [ ] should never matter here
+- [x] should never matter here
"""


class DetectPhaseCompletionTests(unittest.TestCase):
    def test_added_checkbox_in_plan_file_is_detected(self) -> None:
        self.assertTrue(detect_phase_completion(PLAN_DIFF_CHECKED))

    def test_plain_added_line_is_not_detected(self) -> None:
        self.assertFalse(detect_phase_completion(PLAN_DIFF_UNCHECKED))

    def test_reviews_path_is_ignored(self) -> None:
        self.assertFalse(detect_phase_completion(REVIEWS_DIFF_CHECKED))

    def test_reports_path_is_ignored(self) -> None:
        self.assertFalse(detect_phase_completion(REPORTS_DIFF_CHECKED))

    def test_empty_diff_is_not_detected(self) -> None:
        self.assertFalse(detect_phase_completion(""))

    def test_removed_checkbox_line_is_not_detected(self) -> None:
        diff = """\
diff --git a/docs/superpowers/plans/x.md b/docs/superpowers/plans/x.md
--- a/docs/superpowers/plans/x.md
+++ b/docs/superpowers/plans/x.md
@@ -1,2 +1,1 @@
-- [x] Ship phase 1
"""
        self.assertFalse(detect_phase_completion(diff))


class ExtractPreviewUrlsTests(unittest.TestCase):
    def test_extracts_single_url(self) -> None:
        text = "Preview ready at https://inventory-8k3s.vercel.app for review."
        self.assertEqual(
            extract_preview_urls(text), ["https://inventory-8k3s.vercel.app"]
        )

    def test_dedup_preserves_order(self) -> None:
        text = (
            "First https://foo-bar.vercel.app then https://baz-qux.vercel.app "
            "then again https://foo-bar.vercel.app"
        )
        self.assertEqual(
            extract_preview_urls(text),
            ["https://foo-bar.vercel.app", "https://baz-qux.vercel.app"],
        )

    def test_no_match_returns_empty_list(self) -> None:
        self.assertEqual(extract_preview_urls("nothing to see here"), [])

    def test_non_vercel_url_is_ignored(self) -> None:
        text = "See https://example.com/not-a-preview and https://real.vercel.app"
        self.assertEqual(extract_preview_urls(text), ["https://real.vercel.app"])


class ShouldFireTests(unittest.TestCase):
    def test_first_call_fires_and_records_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            now_iso = datetime.now(timezone.utc).isoformat()
            result = should_fire(root, "plan-key-1", now_iso=now_iso)
            self.assertTrue(result)
            hookmarks = root / ".fable5" / "hookmarks"
            self.assertTrue(hookmarks.is_dir())
            # One per-plan debounce marker plus one daily counter marker.
            markers = list(hookmarks.glob("*.json"))
            self.assertEqual(len(markers), 2)

    def test_debounce_within_30_min_blocks_second_fire(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            now_iso = datetime.now(timezone.utc).isoformat()
            first = should_fire(root, "plan-key-1", now_iso=now_iso)
            self.assertTrue(first)
            later_iso = (
                datetime.now(timezone.utc) + timedelta(minutes=10)
            ).isoformat()
            second = should_fire(root, "plan-key-1", now_iso=later_iso)
            self.assertFalse(second)

    def test_fire_allowed_again_after_30_min(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            now_iso = datetime.now(timezone.utc).isoformat()
            first = should_fire(root, "plan-key-1", now_iso=now_iso)
            self.assertTrue(first)
            later_iso = (
                datetime.now(timezone.utc) + timedelta(minutes=31)
            ).isoformat()
            second = should_fire(root, "plan-key-1", now_iso=later_iso)
            self.assertTrue(second)

    def test_different_plan_keys_do_not_debounce_each_other(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            now_iso = datetime.now(timezone.utc).isoformat()
            first = should_fire(root, "plan-key-1", now_iso=now_iso)
            second = should_fire(root, "plan-key-2", now_iso=now_iso)
            self.assertTrue(first)
            self.assertTrue(second)

    def test_daily_cap_of_four_blocks_fifth_fire(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = datetime.now(timezone.utc)
            results = []
            for index in range(5):
                # Space calls 31 minutes apart so per-plan debounce never blocks,
                # only the daily cap is under test. Different plan keys too, to
                # isolate the daily-cap mechanism from the debounce mechanism.
                when = (base + timedelta(minutes=31 * index)).isoformat()
                results.append(should_fire(root, f"plan-key-{index}", now_iso=when))
            self.assertEqual(results, [True, True, True, True, False])

    def test_daily_cap_resets_on_new_day(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Keep all 4 fires (31 min apart, to dodge the per-plan debounce
            # between distinct plan keys is irrelevant here anyway) well inside
            # a single UTC calendar day, so the daily counter reaches exactly 4.
            base = datetime(2026, 7, 19, 2, 0, 0, tzinfo=timezone.utc)
            for index in range(4):
                when = (base + timedelta(minutes=31 * index)).isoformat()
                self.assertTrue(should_fire(root, f"plan-key-{index}", now_iso=when))
            fifth_same_day = (base + timedelta(minutes=31 * 4)).isoformat()
            self.assertFalse(should_fire(root, "plan-key-4", now_iso=fifth_same_day))

            next_day = datetime(2026, 7, 20, 1, 0, 0, tzinfo=timezone.utc).isoformat()
            self.assertTrue(should_fire(root, "plan-key-5", now_iso=next_day))


class SessionStartHookCliTests(unittest.TestCase):
    def _run_cli(self, root: Path, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        import os

        env = dict(os.environ)
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            [sys.executable, "-m", "tools.fable5.hook_support", "sessionstart-hook", "--repo", str(root)],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(Path(__file__).resolve().parents[3]),
            env=env,
        )

    def test_no_fixtures_prints_nothing_or_neutral_line(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run_cli(root)
            self.assertEqual(completed.returncode, 0)
            lines = [line for line in completed.stdout.splitlines() if line.strip()]
            self.assertLessEqual(len(lines), 4)

    def test_latest_verdict_line_present(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reviews_dir = root / "docs" / "reviews"
            reviews_dir.mkdir(parents=True)
            (reviews_dir / "LATEST.json").write_text(
                json.dumps(
                    {
                        "verdict": "PASS",
                        "run_id": "20260719T000000Z-fast",
                        "report": "reports/fable5/20260719T000000Z-fast/report.md",
                        "top_blockers": [],
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "cost_note": "subscription; true spend = provider console",
                    }
                ),
                encoding="utf-8",
            )
            completed = self._run_cli(root)
            self.assertEqual(completed.returncode, 0)
            self.assertIn("PASS", completed.stdout)
            self.assertIn("20260719T000000Z-fast", completed.stdout)
            lines = [line for line in completed.stdout.splitlines() if line.strip()]
            self.assertLessEqual(len(lines), 4)

    def test_running_lock_line_present_when_held(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            (state_dir / "running.json").write_text(
                json.dumps(
                    {
                        "pid": 424242,
                        "started_at": datetime.now(timezone.utc).isoformat(),
                        "mode": "fast",
                        "wall_clock_limit_min": 15,
                    }
                ),
                encoding="utf-8",
            )
            (state_dir / "run.lock").write_text("", encoding="utf-8")
            completed = self._run_cli(root)
            self.assertEqual(completed.returncode, 0)
            self.assertIn("424242", completed.stdout)
            self.assertIn("taskkill", completed.stdout)

    def test_pending_preview_line_present_when_nonempty(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            (state_dir / "pending-preview.json").write_text(
                json.dumps({"urls": ["https://foo-bar.vercel.app"]}), encoding="utf-8"
            )
            completed = self._run_cli(root)
            self.assertEqual(completed.returncode, 0)
            self.assertIn("https://foo-bar.vercel.app", completed.stdout)
            self.assertIn("autoRunPreviewStress=ask", completed.stdout)

    def test_empty_pending_preview_produces_no_preview_line(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            (state_dir / "pending-preview.json").write_text(
                json.dumps({"urls": []}), encoding="utf-8"
            )
            completed = self._run_cli(root)
            self.assertEqual(completed.returncode, 0)
            self.assertNotIn("autoRunPreviewStress", completed.stdout)

    def test_all_three_fixtures_combine_to_four_lines_max(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reviews_dir = root / "docs" / "reviews"
            reviews_dir.mkdir(parents=True)
            (reviews_dir / "LATEST.json").write_text(
                json.dumps(
                    {
                        "verdict": "BLOCK",
                        "run_id": "run-1",
                        "report": "reports/fable5/run-1/report.md",
                        "top_blockers": ["a: broke"],
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "cost_note": "subscription; true spend = provider console",
                    }
                ),
                encoding="utf-8",
            )
            state_dir = root / ".fable5"
            state_dir.mkdir(parents=True)
            (state_dir / "running.json").write_text(
                json.dumps(
                    {
                        "pid": 111,
                        "started_at": datetime.now(timezone.utc).isoformat(),
                        "mode": "fast",
                        "wall_clock_limit_min": 15,
                    }
                ),
                encoding="utf-8",
            )
            (state_dir / "run.lock").write_text("", encoding="utf-8")
            (state_dir / "pending-preview.json").write_text(
                json.dumps({"urls": ["https://foo-bar.vercel.app"]}), encoding="utf-8"
            )
            completed = self._run_cli(root)
            self.assertEqual(completed.returncode, 0)
            lines = [line for line in completed.stdout.splitlines() if line.strip()]
            self.assertLessEqual(len(lines), 4)
            self.assertIn("BLOCK", completed.stdout)
            self.assertIn("111", completed.stdout)
            self.assertIn("foo-bar.vercel.app", completed.stdout)


class StopHookCliTests(unittest.TestCase):
    def _init_repo(self, root: Path) -> None:
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
        plans_dir = root / "docs" / "superpowers" / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "plan.md").write_text("- [ ] Ship phase 1\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=root, check=True)

    def _run_stop_hook(self, root: Path, payload: dict) -> subprocess.CompletedProcess:
        import os

        env = dict(os.environ)
        return subprocess.run(
            [sys.executable, "-m", "tools.fable5.hook_support", "stop-hook", "--repo", str(root)],
            input=json.dumps(payload),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(Path(__file__).resolve().parents[3]),
            env=env,
        )

    def test_checked_box_staged_fires(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._init_repo(root)
            plan_path = root / "docs" / "superpowers" / "plans" / "plan.md"
            plan_path.write_text("- [x] Ship phase 1\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=root, check=True)

            transcript_path = root / "transcript.jsonl"
            transcript_path.write_text("no preview urls here\n", encoding="utf-8")
            payload = {"transcript_path": str(transcript_path)}
            completed = self._run_stop_hook(root, payload)
            self.assertEqual(completed.returncode, 0)
            self.assertIn("FIRE", completed.stdout)

    def test_no_checked_box_does_not_fire(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._init_repo(root)
            plan_path = root / "docs" / "superpowers" / "plans" / "plan.md"
            plan_path.write_text("- [ ] Ship phase 1\n- still unchecked\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=root, check=True)

            transcript_path = root / "transcript.jsonl"
            transcript_path.write_text("no preview urls here\n", encoding="utf-8")
            payload = {"transcript_path": str(transcript_path)}
            completed = self._run_stop_hook(root, payload)
            self.assertEqual(completed.returncode, 0)
            self.assertNotIn("FIRE", completed.stdout)

    def test_transcript_preview_url_written_to_pending_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._init_repo(root)
            transcript_path = root / "transcript.jsonl"
            transcript_path.write_text(
                "deployed to https://my-preview-abc.vercel.app for testing\n",
                encoding="utf-8",
            )
            payload = {"transcript_path": str(transcript_path)}
            completed = self._run_stop_hook(root, payload)
            self.assertEqual(completed.returncode, 0)
            pending_path = root / ".fable5" / "pending-preview.json"
            self.assertTrue(pending_path.is_file())
            data = json.loads(pending_path.read_text(encoding="utf-8"))
            self.assertIn("https://my-preview-abc.vercel.app", data["urls"])

    def test_missing_transcript_path_does_not_crash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._init_repo(root)
            payload = {"transcript_path": str(root / "does-not-exist.jsonl")}
            completed = self._run_stop_hook(root, payload)
            self.assertEqual(completed.returncode, 0)

    def test_malformed_stdin_does_not_crash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._init_repo(root)
            import os

            env = dict(os.environ)
            completed = subprocess.run(
                [sys.executable, "-m", "tools.fable5.hook_support", "stop-hook", "--repo", str(root)],
                input="not json at all",
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(Path(__file__).resolve().parents[3]),
                env=env,
            )
            self.assertEqual(completed.returncode, 0)


if __name__ == "__main__":
    unittest.main()
