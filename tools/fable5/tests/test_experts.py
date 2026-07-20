from __future__ import annotations

import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tools.fable5.experts import (
    Envelope,
    build_claude_command,
    parse_envelope,
    run_experts,
    subscription_preflight,
)


class ExpertTests(unittest.TestCase):
    def test_command_is_noninteractive_read_only_fable(self) -> None:
        command = build_claude_command("security", "fable", "review")
        self.assertIn("--print", command)
        self.assertEqual(command[command.index("--agent") + 1], "security")
        self.assertEqual(command[command.index("--model") + 1], "fable")
        self.assertEqual(command[command.index("--permission-mode") + 1], "plan")
        self.assertEqual(command[command.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(command[command.index("--max-budget-usd") + 1], "0.50")
        self.assertEqual(command[command.index("--effort") + 1], "high")
        self.assertNotIn("--dangerously-skip-permissions", command)

    def test_command_defaults_effort_to_high(self) -> None:
        command = build_claude_command("security", "fable", "review")
        self.assertEqual(command[command.index("--effort") + 1], "high")

    def test_command_accepts_explicit_effort(self) -> None:
        command = build_claude_command("security", "fable", "review", effort="medium")
        self.assertEqual(command[command.index("--effort") + 1], "medium")


class ParseEnvelopeTests(unittest.TestCase):
    def test_parses_well_formed_result_envelope(self) -> None:
        stdout = json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "result": "the model text",
                "usage": {"input_tokens": 123, "output_tokens": 45},
                "total_cost_usd": 0.19,
            }
        )
        envelope = parse_envelope(stdout)
        self.assertEqual(
            envelope,
            Envelope(
                result_text="the model text",
                cost_usd=0.19,
                input_tokens=123,
                output_tokens=45,
            ),
        )

    def test_malformed_json_falls_back_to_raw_stdout(self) -> None:
        stdout = "not json at all"
        envelope = parse_envelope(stdout)
        self.assertEqual(
            envelope,
            Envelope(result_text="not json at all", cost_usd=None, input_tokens=None, output_tokens=None),
        )

    def test_missing_usage_and_cost_fields_are_none(self) -> None:
        stdout = json.dumps({"type": "result", "subtype": "success", "result": "text"})
        envelope = parse_envelope(stdout)
        self.assertEqual(envelope.result_text, "text")
        self.assertIsNone(envelope.cost_usd)
        self.assertIsNone(envelope.input_tokens)
        self.assertIsNone(envelope.output_tokens)


def _fixture_script(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


class SubscriptionPreflightTests(unittest.TestCase):
    def test_claude_ai_auth_with_no_api_key_source_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            script = _fixture_script(
                Path(temporary),
                "auth_ok.py",
                """
                import json
                print(json.dumps({"authMethod": "claude.ai", "subscriptionType": "max"}))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {script}"},
            ):
                ok, detail = subscription_preflight()
        self.assertTrue(ok)
        self.assertIn("claude.ai", detail)

    def test_stray_api_key_source_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            script = _fixture_script(
                Path(temporary),
                "auth_bad.py",
                """
                import json
                print(json.dumps({
                    "authMethod": None,
                    "subscriptionType": None,
                    "apiKeySource": "ANTHROPIC_API_KEY",
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {script}"},
            ):
                ok, detail = subscription_preflight()
        self.assertFalse(ok)
        self.assertIn("apiKeySource", detail)

    def test_nonzero_exit_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            script = _fixture_script(
                Path(temporary),
                "auth_exit.py",
                """
                raise SystemExit(1)
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {script}"},
            ):
                ok, detail = subscription_preflight()
        self.assertFalse(ok)

    def test_malformed_json_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            script = _fixture_script(
                Path(temporary),
                "auth_junk.py",
                """
                print("not json")
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {script}"},
            ):
                ok, detail = subscription_preflight()
        self.assertFalse(ok)


class RunExpertsPreflightTests(unittest.IsolatedAsyncioTestCase):
    async def test_preflight_failure_skips_every_expert_without_launching(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _fixture_script(
                root,
                "auth_bad.py",
                """
                import json
                print(json.dumps({"apiKeySource": "ANTHROPIC_API_KEY"}))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {script}"},
            ):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security", "code-review"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=2,
                    timeout_seconds=5,
                )
        self.assertEqual(len(results), 2)
        for result in results:
            self.assertEqual(result.status, "skipped")
            self.assertIn("apiKeySource", result.reason)


class RunOneCostGateTests(unittest.IsolatedAsyncioTestCase):
    def _passing_preflight(self, temporary: Path) -> Path:
        return _fixture_script(
            temporary,
            "auth_ok.py",
            """
            import json
            print(json.dumps({"authMethod": "claude.ai", "subscriptionType": "max"}))
            """,
        )

    async def test_nonzero_cost_failure_is_blocking_when_allow_paid_false(self) -> None:
        """When cost is detected and allow_paid=False, result.blocking must be True."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "ok",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                    "total_cost_usd": 0.42,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                    allow_paid=False,
                )
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.blocking, "Cost-detected failure must have blocking=True to exit 1")

    async def test_nonzero_cost_success_is_not_blocking_when_allow_paid_true(self) -> None:
        """When cost is detected and allow_paid=True, result.blocking must be False (status passes)."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "ok",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                    "total_cost_usd": 0.42,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                    allow_paid=True,
                )
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.status, "passed")
        self.assertFalse(result.blocking, "Allowed cost success must have blocking=False")

    async def test_nonzero_cost_fails_closed_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "ok",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                    "total_cost_usd": 0.42,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                )
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.status, "failed")
        self.assertIn("metered API cost detected: $0.42", result.reason)
        self.assertIn("subscription-only policy", result.reason)
        self.assertIn("true spend = provider console", result.reason)

    async def test_nonzero_cost_with_allow_paid_reports_but_does_not_fail_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "ok",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                    "total_cost_usd": 0.42,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                    allow_paid=True,
                )
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.status, "passed")
        self.assertIn("0.42", result.reason)
        self.assertIn("true spend = provider console", result.reason)

    async def test_zero_cost_success_reports_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "ok",
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                    "total_cost_usd": 0.0,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                )
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.status, "passed")
        self.assertIn("input_tokens=10", result.reason)
        self.assertIn("output_tokens=5", result.reason)

    async def test_none_cost_success_reports_tokens_without_cost_phrase(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "ok",
                    "usage": {"input_tokens": 7, "output_tokens": 3},
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                results = await run_experts(
                    root=root,
                    report_dir=root / "report",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                )
        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertEqual(result.status, "passed")
        self.assertIn("input_tokens=7", result.reason)
        self.assertIn("output_tokens=3", result.reason)
        self.assertNotIn("true spend", result.reason)


if __name__ == "__main__":
    unittest.main()
