from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from tools.fable5.docs_check import check_docs


class DocsCheckTests(unittest.TestCase):
    def test_clean_doc_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See `tools/fable5/cli.py` and run `npm run build`.\n"
                "Also see [the config](tools/fable5/config.py).\n",
                encoding="utf-8",
            )
            (root / "tools" / "fable5").mkdir(parents=True)
            (root / "tools" / "fable5" / "cli.py").write_text("", encoding="utf-8")
            (root / "tools" / "fable5" / "config.py").write_text("", encoding="utf-8")

            results = check_docs(root, ["README.md"], {"build"})

            self.assertEqual(len(results), 1)
            result = results[0]
            self.assertEqual(result.check_id, "docs-staleness:README.md")
            self.assertEqual(result.status, "passed")
            self.assertFalse(result.blocking)

    def test_dead_path_is_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See `tools/fable5/missing_file.py` for details.\n", encoding="utf-8"
            )

            results = check_docs(root, ["README.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertFalse(result.blocking)
            self.assertIn("tools/fable5/missing_file.py", result.reason)

    def test_dead_npm_script_is_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "Run `npm run does-not-exist` to build.\n", encoding="utf-8"
            )

            results = check_docs(root, ["README.md"], {"build", "lint"})

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertIn("npm run does-not-exist", result.reason)

    def test_broken_relative_link_is_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "docs").mkdir()
            (root / "docs" / "README.md").write_text(
                "See [the plan](../PLAN.md) for details.\n", encoding="utf-8"
            )

            results = check_docs(root, ["docs/README.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertIn("../PLAN.md", result.reason)

    def test_relative_link_resolves_from_doc_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "docs").mkdir()
            (root / "docs" / "README.md").write_text(
                "See [the plan](PLAN.md) for details.\n", encoding="utf-8"
            )
            (root / "docs" / "PLAN.md").write_text("", encoding="utf-8")

            results = check_docs(root, ["docs/README.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_link_fragment_is_stripped_before_existence_check(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See [the section](docs/GUIDE.md#some-heading) for details.\n", encoding="utf-8"
            )
            (root / "docs").mkdir()
            (root / "docs" / "GUIDE.md").write_text("", encoding="utf-8")

            results = check_docs(root, ["README.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_http_and_mailto_links_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See [our site](https://example.com/path) or "
                "[email us](mailto:owner@example.com).\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_glob_placeholder_url_and_flag_spans_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "Matches `src/**/*.ts`, placeholder `<path/to/file.ts>`, "
                "url `https://example.com/file.ts`, and flag `--no-cache`.\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_missing_doc_file_is_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            results = check_docs(root, ["MISSING.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertEqual(result.reason, "file not found")
            self.assertFalse(result.blocking)

    def test_progress_lag_alone_is_info_not_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plans_dir = root / "docs" / "superpowers" / "plans"
            plans_dir.mkdir(parents=True)
            (root / "PROGRESS.md").write_text("Status: on track.\n", encoding="utf-8")
            # Make the plan file newer than PROGRESS.md.
            time.sleep(0.05)
            (plans_dir / "2026-07-19-master-plan.md").write_text("Plan.\n", encoding="utf-8")
            # Ensure filesystem-visible mtime ordering on coarse-grained filesystems.
            now = time.time()
            import os

            os.utime(root / "PROGRESS.md", (now - 10, now - 10))
            os.utime(plans_dir / "2026-07-19-master-plan.md", (now, now))

            results = check_docs(root, ["PROGRESS.md"], set())

            result = results[0]
            self.assertEqual(result.status, "passed")
            self.assertIn("PROGRESS.md lags the newest plan (allowed by doctrine)", result.reason)

    def test_progress_lag_combined_with_real_issue_still_warns(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plans_dir = root / "docs" / "superpowers" / "plans"
            plans_dir.mkdir(parents=True)
            (root / "PROGRESS.md").write_text(
                "See `tools/fable5/missing.py`.\n", encoding="utf-8"
            )
            time.sleep(0.05)
            (plans_dir / "2026-07-19-master-plan.md").write_text("Plan.\n", encoding="utf-8")
            import os

            now = time.time()
            os.utime(root / "PROGRESS.md", (now - 10, now - 10))
            os.utime(plans_dir / "2026-07-19-master-plan.md", (now, now))

            results = check_docs(root, ["PROGRESS.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertIn("tools/fable5/missing.py", result.reason)
            self.assertIn("PROGRESS.md lags the newest plan (allowed by doctrine)", result.reason)

    def test_multiple_docs_yield_one_result_each(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "A.md").write_text("Clean doc.\n", encoding="utf-8")
            (root / "B.md").write_text("Clean doc too.\n", encoding="utf-8")

            results = check_docs(root, ["A.md", "B.md"], set())

            self.assertEqual([result.check_id for result in results], [
                "docs-staleness:A.md",
                "docs-staleness:B.md",
            ])

    def test_bracket_alternation_npm_span_is_not_flagged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "Run `npm run qa:bots[:tire|:security|:ux|:data|...]` for bot proof.\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md"], {"qa:bots:tire", "qa:bots:security"})

            result = results[0]
            self.assertEqual(result.status, "passed")
            self.assertNotIn("qa:bots:", result.reason)

    def test_shell_command_span_is_not_flagged_as_dead_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "Run `node scripts/create-god-account.mjs` to provision.\n"
                "Run `npx playwright test e2e/scan.spec.ts` for one spec.\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md"], set())

            result = results[0]
            self.assertEqual(result.status, "passed")

    def test_http_route_span_is_not_flagged_as_dead_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "`POST /api/ai-lookup` starts a decode.\n"
                "`GET/POST /api/ai-lookup` reports config too.\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md"], set())

            result = results[0]
            self.assertEqual(result.status, "passed")

    def test_plain_dead_path_is_still_caught(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See `src/services/missing_thing.ts` for details.\n", encoding="utf-8"
            )

            results = check_docs(root, ["README.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertIn("src/services/missing_thing.ts", result.reason)

    def test_duplicate_dead_reference_appears_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See `src/services/missing_thing.ts` here and again "
                "`src/services/missing_thing.ts` there.\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            occurrences = result.reason.count("src/services/missing_thing.ts")
            self.assertEqual(occurrences, 1)

    def test_never_returns_failed_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "See `tools/fable5/missing_file.py` and run `npm run ghost` and "
                "[broken](nope.md).\n",
                encoding="utf-8",
            )

            results = check_docs(root, ["README.md", "ALSO_MISSING.md"], set())

            for result in results:
                self.assertIn(result.status, {"passed", "warning"})

    def test_src_relative_shorthand_resolves(self) -> None:
        # Docs reference source files relative to src/ (`services/resolver.ts` for
        # `src/services/resolver.ts`); that real file must not be called dead.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "CLAUDE.md").write_text("See `services/resolver.ts`.\n", encoding="utf-8")
            target = root / "src" / "services" / "resolver.ts"
            target.parent.mkdir(parents=True)
            target.write_text("", encoding="utf-8")

            results = check_docs(root, ["CLAUDE.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_at_alias_resolves_to_src(self) -> None:
        # `@/` is the tsconfig alias for src/; both the file and the dir form must resolve.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "CLAUDE.md").write_text(
                "See `@/server/upc/index.ts` and the `@/server/upc` module.\n", encoding="utf-8"
            )
            target = root / "src" / "server" / "upc" / "index.ts"
            target.parent.mkdir(parents=True)
            target.write_text("", encoding="utf-8")

            results = check_docs(root, ["CLAUDE.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_branch_name_token_is_not_flagged_as_dead_path(self) -> None:
        # A git branch name looks path-like but is not a file; do not flag it.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "CLAUDE.md").write_text(
                "Work continues on `feat/decode-ladder-goupc`.\n", encoding="utf-8"
            )

            results = check_docs(root, ["CLAUDE.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_bare_filename_under_src_resolves(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "CLAUDE.md").write_text("`brandFamilies.ts` keeps siblings.\n", encoding="utf-8")
            target = root / "src" / "services" / "catalog" / "brandFamilies.ts"
            target.parent.mkdir(parents=True)
            target.write_text("", encoding="utf-8")

            results = check_docs(root, ["CLAUDE.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_leading_slash_route_is_not_flagged_as_dead_path(self) -> None:
        # A bare API-route reference (no HTTP verb prefix) is not a filesystem path.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "CLAUDE.md").write_text("`/api/ai-lookup` runs the ladder.\n", encoding="utf-8")

            results = check_docs(root, ["CLAUDE.md"], set())

            self.assertEqual(results[0].status, "passed")

    def test_dead_src_relative_shorthand_is_still_caught(self) -> None:
        # Leniency must not suppress a genuinely dead src-relative reference.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "src").mkdir()
            (root / "CLAUDE.md").write_text("See `services/ghost.ts`.\n", encoding="utf-8")

            results = check_docs(root, ["CLAUDE.md"], set())

            result = results[0]
            self.assertEqual(result.status, "warning")
            self.assertIn("services/ghost.ts", result.reason)


if __name__ == "__main__":
    unittest.main()
