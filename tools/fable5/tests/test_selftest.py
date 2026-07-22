from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools.fable5.selftest import (
    CanaryCase,
    load_cases,
    prepare_case,
    run_case,
    run_selftest,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
CASES_DIR = REPO_ROOT / "tools" / "fable5" / "selftest" / "cases"


class CanaryLoaderTests(unittest.TestCase):
    def test_loads_exactly_the_five_seed_canaries(self) -> None:
        cases = load_cases(CASES_DIR)

        self.assertEqual(
            {case.name for case in cases},
            {
                "double-charge",
                "secret-leak",
                "em-dash-copy",
                "plan-without-proof",
                "dead-doc-ref",
            },
        )
        self.assertTrue(all(case.target_files for case in cases))
        self.assertTrue(all(case.patch.startswith("--- a/") for case in cases))


class ScratchCopyTests(unittest.TestCase):
    def test_copies_only_targets_and_applies_unified_patch(self) -> None:
        case = CanaryCase(
            name="copy-isolation",
            target_files=("src/target.txt",),
            patch=(
                "--- a/src/target.txt\n"
                "+++ b/src/target.txt\n"
                "@@ -1 +1 @@\n"
                "-safe\n"
                "+mutated\n"
            ),
            expected_detector="docs-check",
        )
        with tempfile.TemporaryDirectory() as repository_temp:
            repository = Path(repository_temp)
            (repository / "src").mkdir()
            (repository / "src" / "target.txt").write_text("safe\n", encoding="utf-8")
            (repository / "ignored.txt").write_text("do not copy\n", encoding="utf-8")
            with tempfile.TemporaryDirectory() as scratch_temp:
                scratch = Path(scratch_temp)
                copied = prepare_case(repository, case, scratch)

                self.assertEqual(copied, (scratch / "src" / "target.txt",))
                self.assertEqual(copied[0].read_text(encoding="utf-8"), "mutated\n")
                self.assertFalse((scratch / "ignored.txt").exists())
                self.assertFalse((scratch / ".git").exists())


class CanaryExecutionTests(unittest.TestCase):
    def test_all_seed_canaries_are_detected(self) -> None:
        results = run_selftest(REPO_ROOT, CASES_DIR)

        self.assertEqual(len(results), 5)
        self.assertTrue(all(result.status == "passed" for result in results))

    def test_intentional_miss_is_loud(self) -> None:
        case = CanaryCase(
            name="intentional-miss",
            target_files=("tools/fable5/fixtures/selftest/plan.md",),
            patch=(
                "--- a/tools/fable5/fixtures/selftest/plan.md\n"
                "+++ b/tools/fable5/fixtures/selftest/plan.md\n"
                "@@ -1 +1 @@\n"
                "-# Canary plan\n"
                "+# Canary plan title\n"
            ),
            expected_detector="plan-review",
        )

        result = run_case(REPO_ROOT, case)

        self.assertEqual(result.status, "failed")
        self.assertTrue(result.blocking)
        self.assertIn("did not detect", result.reason)


if __name__ == "__main__":
    unittest.main()
