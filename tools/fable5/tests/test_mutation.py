from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.fable5.cli import _hook_triggered_refusal, _mutation_requested, build_parser
from tools.fable5.mutation import (
    MAX_MUTANTS,
    MUTANT_TIMEOUT_SECONDS,
    contains_database_dependency,
    generate_mutants,
    run_mutation_probes,
)


FIXTURES = Path(__file__).with_name("fixtures")


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


class MutationTests(unittest.TestCase):
    def _fixture_repo(self, test_fixture: str) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        fixture_dir = root / "src"
        fixture_dir.mkdir()
        shutil.copyfile(FIXTURES / "mutation_target.ts", fixture_dir / "mutation_target.ts")
        shutil.copyfile(FIXTURES / test_fixture, fixture_dir / "mutation_target.test.ts")
        (root / "node_modules").mkdir()
        _git(root, "init", "--quiet")
        _git(root, "config", "user.email", "fable5@example.invalid")
        _git(root, "config", "user.name", "Fable5 Tests")
        _git(root, "add", "src/mutation_target.ts", "src/mutation_target.test.ts")
        _git(root, "commit", "--quiet", "-m", "fixture")
        return temporary, root

    def _runner_env(self) -> dict[str, str]:
        command = [
            sys.executable,
            str(FIXTURES / "mutation_stub_runner.py"),
            "{source}",
            "{test}",
        ]
        return {"FABLE5_MUTATION_RUNNER": json.dumps(command)}

    def test_generates_deterministic_mutants_with_session_cap(self) -> None:
        source = "\n".join(f"const value{i} = input{i} > 0;" for i in range(20))

        mutants = generate_mutants(source)

        self.assertEqual(len(mutants), MAX_MUTANTS)
        self.assertTrue(all(mutant.apply(source) != source for mutant in mutants))

    def test_database_dependency_match_is_case_insensitive(self) -> None:
        self.assertTrue(contains_database_dependency("import Database from 'better-sqlite3'"))
        self.assertTrue(contains_database_dependency("import { x } from '@LIBSQL/client'"))
        self.assertTrue(contains_database_dependency("const url = 'libsql://local'"))
        self.assertFalse(contains_database_dependency("import { describe } from 'vitest'"))

    def test_weak_sibling_test_survives_mutants_in_one_worktree(self) -> None:
        temporary, root = self._fixture_repo("mutation_target.test.ts")
        self.addCleanup(temporary.cleanup)
        from tools.fable5 import mutation

        calls = 0
        original = mutation._add_worktree

        def tracked_add_worktree(repo: Path, worktree: Path) -> None:
            nonlocal calls
            calls += 1
            original(repo, worktree)

        with (
            mock.patch.dict(os.environ, self._runner_env(), clear=False),
            mock.patch("tools.fable5.mutation._add_worktree", tracked_add_worktree),
        ):
            result = run_mutation_probes(
                root=root,
                changed_files=["src/mutation_target.ts"],
                report_dir=root / "reports" / "fixture",
            )

        self.assertEqual(calls, 1)
        self.assertEqual(result.status, "warning")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("1 survived", result.reason)
        self.assertIn("src/mutation_target.test.ts", result.output_tail)

    def test_strong_sibling_test_kills_mutants(self) -> None:
        temporary, root = self._fixture_repo("mutation_target.strong.test.ts")
        self.addCleanup(temporary.cleanup)

        with mock.patch.dict(os.environ, self._runner_env(), clear=False):
            result = run_mutation_probes(
                root=root,
                changed_files=["src/mutation_target.ts"],
                report_dir=root / "reports" / "fixture",
            )

        self.assertEqual(result.status, "passed")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("1 killed", result.reason)
        self.assertNotIn("survived", result.reason)

    def test_database_import_skips_file_before_worktree_creation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "src" / "unsafe.ts"
            source.parent.mkdir()
            source.write_text("export const value = true;\n", encoding="utf-8")
            source.with_name("unsafe.test.ts").write_text(
                "import Database from 'better-sqlite3';\n", encoding="utf-8"
            )
            with mock.patch("tools.fable5.mutation._add_worktree") as add_worktree:
                result = run_mutation_probes(
                    root=root,
                    changed_files=["src/unsafe.ts"],
                    report_dir=root / "report",
                )

        add_worktree.assert_not_called()
        self.assertEqual(result.status, "skipped")
        self.assertIn("database dependency", result.reason)

    def test_only_exact_sibling_test_ts_is_eligible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "src" / "value.ts"
            source.parent.mkdir()
            source.write_text("export const value = true;\n", encoding="utf-8")
            source.with_name("value.spec.ts").write_text("test('value', () => {});\n", encoding="utf-8")
            source.with_name("value.test.tsx").write_text("test('value', () => {});\n", encoding="utf-8")
            result = run_mutation_probes(
                root=root,
                changed_files=["src/value.ts"],
                report_dir=root / "report",
            )

        self.assertEqual(result.status, "skipped")
        self.assertIn("no sibling .test.ts", result.reason)

    def test_runner_uses_120_second_timeout(self) -> None:
        completed = subprocess.CompletedProcess(["stub"], returncode=0, stdout="ok")
        from tools.fable5 import mutation

        with mock.patch("tools.fable5.mutation.subprocess.run", return_value=completed) as run:
            mutation._run_test_command(
                ["stub"], cwd=Path.cwd(), environment={}, timeout_seconds=MUTANT_TIMEOUT_SECONDS
            )

        self.assertEqual(run.call_args.kwargs["timeout"], 120)

    def test_pr_monthly_or_explicit_flag_requests_mutation(self) -> None:
        parser = build_parser()
        self.assertTrue(_mutation_requested(parser.parse_args(["review-build", "--gate", "pr"])))
        self.assertTrue(
            _mutation_requested(parser.parse_args(["review-build", "--gate", "monthly"]))
        )
        self.assertTrue(_mutation_requested(parser.parse_args(["review-build", "--mutation"])))
        self.assertFalse(_mutation_requested(parser.parse_args(["review-build"])))

    def test_hook_trigger_refuses_explicit_and_pr_mutation(self) -> None:
        parser = build_parser()
        explicit = parser.parse_args(["review-build", "--mutation"])
        automatic = parser.parse_args(["review-build", "--gate", "pr"])

        self.assertEqual(
            _hook_triggered_refusal(explicit),
            "hook-triggered runs are deterministic-only: mutation probes refused",
        )
        self.assertEqual(
            _hook_triggered_refusal(automatic),
            "hook-triggered runs are deterministic-only: mutation probes refused",
        )


if __name__ == "__main__":
    unittest.main()
