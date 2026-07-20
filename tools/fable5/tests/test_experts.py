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
    Finding,
    build_claude_command,
    parse_envelope,
    parse_findings,
    run_experts,
    subscription_preflight,
)
from tools.fable5.ledger import open_ledger


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


class ExpertLogRedactionTests(unittest.IsolatedAsyncioTestCase):
    async def test_raw_expert_log_redacts_secret_output(self) -> None:
        secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = _fixture_script(
                root,
                "auth_ok.py",
                """
                import json
                print(json.dumps({"authMethod": "claude.ai", "subscriptionType": "max"}))
                """,
            )
            fake_claude = _fixture_script(
                root,
                "fake_claude.py",
                f"""
                import json
                print(json.dumps({{
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps({{"findings": []}}),
                    "debug": {secret!r},
                    "usage": {{"input_tokens": 1, "output_tokens": 1}},
                    "total_cost_usd": 0.0,
                }}))
                """,
            )
            report_dir = root / "report"
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(fake_claude)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                await run_experts(
                    root=root,
                    report_dir=report_dir,
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                )

            log_text = (report_dir / "logs" / "expert-security.json").read_text(
                encoding="utf-8"
            )
        self.assertNotIn(secret, log_text)
        self.assertIn("<redacted>", log_text)


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
                    "result": json.dumps({"findings": []}),
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
                    "result": json.dumps({"findings": []}),
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
        # NOTE: prior to the findings pipeline (Argus Task 6), a zero-exit success reason echoed
        # token counts directly. A zero-exit, zero-cost success now ALSO runs parse_findings +
        # verify_findings + the ledger, and the findings-based reason (point 6 of the brief)
        # overrides _success_reason's token-count string on the "passed" path. Token counts are
        # still captured in the JSON envelope logged to log_path; this test now asserts on the
        # findings-based reason contract instead. See argus-task-6-report.md ambiguities.
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
                    "result": json.dumps({"findings": []}),
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
        self.assertIn("findings: 0 confirmed", result.reason)

    async def test_none_cost_success_reports_tokens_without_cost_phrase(self) -> None:
        # See the NOTE in test_zero_cost_success_reports_tokens above: the findings-based reason
        # now overrides the token-count reason on the "passed" path.
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
                    "result": json.dumps({"findings": []}),
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
        self.assertIn("findings: 0 confirmed", result.reason)
        self.assertNotIn("true spend", result.reason)


class ClaudeCmdSeamTests(unittest.TestCase):
    def test_env_seam_replaces_executable_and_appends_call_args(self) -> None:
        with mock.patch.dict(
            "os.environ", {"FABLE5_CLAUDE_CMD": "python fake_claude.py --flag"}
        ):
            command = build_claude_command("security", "fable", "review")
        self.assertEqual(command[0], "python")
        self.assertEqual(command[1], "fake_claude.py")
        self.assertEqual(command[2], "--flag")
        self.assertIn("--agent", command)
        self.assertEqual(command[command.index("--agent") + 1], "security")


class ParseFindingsTests(unittest.TestCase):
    def test_parses_fenced_json_findings_block(self) -> None:
        text = (
            "```json\n"
            + json.dumps(
                {
                    "findings": [
                        {
                            "severity": "blocker",
                            "file": "src/a.py",
                            "line": 10,
                            "claim": "SQL injection",
                            "evidence": "line 10 concatenates input",
                            "fix": "use parameterized query",
                            "confidence": 0.95,
                        }
                    ]
                }
            )
            + "\n```"
        )
        findings = parse_findings(text)
        self.assertEqual(len(findings), 1)
        self.assertEqual(
            findings[0],
            Finding(
                severity="blocker",
                file="src/a.py",
                line=10,
                claim="SQL injection",
                evidence="line 10 concatenates input",
                fix="use parameterized query",
                confidence=0.95,
            ),
        )

    def test_parses_unfenced_plain_json(self) -> None:
        text = json.dumps(
            {
                "findings": [
                    {
                        "severity": "major",
                        "file": "b.py",
                        "line": 1,
                        "claim": "x",
                        "evidence": "y",
                        "fix": "z",
                        "confidence": 0.5,
                    }
                ]
            }
        )
        findings = parse_findings(text)
        self.assertEqual(len(findings), 1)

    def test_no_findings_key_returns_none(self) -> None:
        self.assertIsNone(parse_findings(json.dumps({"other": []})))

    def test_invalid_json_after_fence_strip_returns_none(self) -> None:
        self.assertIsNone(parse_findings("```json\nnot valid json\n```"))

    def test_wrong_type_for_findings_returns_none(self) -> None:
        self.assertIsNone(parse_findings(json.dumps({"findings": "not a list"})))

    def test_confidence_is_clamped_to_0_1(self) -> None:
        text = json.dumps(
            {
                "findings": [
                    {
                        "severity": "minor",
                        "file": "a.py",
                        "line": 1,
                        "claim": "c",
                        "evidence": "e",
                        "fix": "f",
                        "confidence": 5.0,
                    },
                    {
                        "severity": "minor",
                        "file": "a.py",
                        "line": 1,
                        "claim": "c2",
                        "evidence": "e",
                        "fix": "f",
                        "confidence": -3.0,
                    },
                ]
            }
        )
        findings = parse_findings(text)
        self.assertEqual(findings[0].confidence, 1.0)
        self.assertEqual(findings[1].confidence, 0.0)

    def test_unknown_severity_defaults_to_minor(self) -> None:
        text = json.dumps(
            {
                "findings": [
                    {
                        "severity": "catastrophic",
                        "file": "a.py",
                        "line": 1,
                        "claim": "c",
                        "evidence": "e",
                        "fix": "f",
                        "confidence": 0.5,
                    }
                ]
            }
        )
        findings = parse_findings(text)
        self.assertEqual(findings[0].severity, "minor")

    def test_missing_severity_defaults_to_minor(self) -> None:
        text = json.dumps(
            {
                "findings": [
                    {
                        "file": "a.py",
                        "line": 1,
                        "claim": "c",
                        "evidence": "e",
                        "fix": "f",
                        "confidence": 0.5,
                    }
                ]
            }
        )
        findings = parse_findings(text)
        self.assertEqual(findings[0].severity, "minor")

    def test_empty_findings_list_is_valid_and_returns_empty_list(self) -> None:
        findings = parse_findings(json.dumps({"findings": []}))
        self.assertEqual(findings, [])


class PromptContractTests(unittest.TestCase):
    def test_prompt_instructs_json_findings_contract(self) -> None:
        from tools.fable5.experts import _prompt

        prompt = _prompt("security", [], [])
        self.assertIn('"findings"', prompt)
        self.assertIn("severity", prompt)
        self.assertIn("blocker|major|minor", prompt)
        self.assertIn("confidence", prompt)


def _confirm_refute_script(root: Path) -> Path:
    return _fixture_script(
        root,
        "fake_refute.py",
        """
        import json
        print(json.dumps({
            "type": "result",
            "subtype": "success",
            "result": json.dumps({"verdict": "confirmed", "reason": "matches evidence"}),
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "total_cost_usd": 0.0,
        }))
        """,
    )


class RunExpertsFindingsPipelineTests(unittest.IsolatedAsyncioTestCase):
    def _passing_preflight(self, temporary: Path) -> Path:
        return _fixture_script(
            temporary,
            "auth_ok.py",
            """
            import json
            print(json.dumps({"authMethod": "claude.ai", "subscriptionType": "max"}))
            """,
        )

    def _blocker_expert_script(self, root: Path) -> Path:
        return _fixture_script(
            root,
            "fake_claude.py",
            """
            import json
            findings = {
                "findings": [
                    {
                        "severity": "blocker",
                        "file": "src/a.py",
                        "line": 5,
                        "claim": "hardcoded secret",
                        "evidence": "line 5 has an API key literal",
                        "fix": "move to env var",
                        "confidence": 0.9,
                    }
                ]
            }
            print(json.dumps({
                "type": "result",
                "subtype": "success",
                "result": json.dumps(findings),
                "usage": {"input_tokens": 10, "output_tokens": 5},
                "total_cost_usd": 0.0,
            }))
            """,
        )

    async def test_confirmed_blocker_finding_yields_failed_blocking_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            expert_script = self._blocker_expert_script(root)
            refute_script = _confirm_refute_script(root)
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(expert_script)],
            ), mock.patch(
                "tools.fable5.verify.build_refute_command",
                return_value=[sys.executable, str(refute_script)],
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
            self.assertTrue(result.blocking)
            self.assertIn("confirmed", result.reason)
            self.assertIn("blocker", result.reason)
            findings_path = root / "report" / "findings" / "security.json"
            self.assertTrue(findings_path.exists())
            payload = json.loads(findings_path.read_text(encoding="utf-8"))
            self.assertEqual(len(payload), 1)

            conn = open_ledger(root)
            try:
                row = conn.execute("SELECT COUNT(*) FROM findings").fetchone()
                self.assertEqual(row[0], 1)
            finally:
                conn.close()

    async def test_unparseable_expert_output_is_warning_with_zero_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            garbage_script = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "this is not the findings contract at all",
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
                return_value=[sys.executable, str(garbage_script)],
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
            self.assertEqual(result.status, "warning")
            self.assertEqual(result.reason, "unparseable output")

    async def test_no_findings_yields_passed_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            empty_script = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps({"findings": []}),
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
                return_value=[sys.executable, str(empty_script)],
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

    async def test_cache_hit_avoids_second_subprocess_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            auth_script = self._passing_preflight(root)
            counter_path = root / "expert_calls.txt"
            expert_script = _fixture_script(
                root,
                "fake_claude.py",
                f"""
                import json
                from pathlib import Path
                counter_path = Path(r"{counter_path}")
                count = int(counter_path.read_text()) if counter_path.exists() else 0
                count += 1
                counter_path.write_text(str(count))
                findings = {{
                    "findings": [
                        {{
                            "severity": "blocker",
                            "file": "src/a.py",
                            "line": 5,
                            "claim": "hardcoded secret",
                            "evidence": "line 5 has an API key literal",
                            "fix": "move to env var",
                            "confidence": 0.9,
                        }}
                    ]
                }}
                print(json.dumps({{
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps(findings),
                    "usage": {{"input_tokens": 10, "output_tokens": 5}},
                    "total_cost_usd": 0.0,
                }}))
                """,
            )
            refute_script = _confirm_refute_script(root)
            with mock.patch.dict(
                "os.environ",
                {"FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}"},
            ), mock.patch(
                "tools.fable5.experts.build_claude_command",
                return_value=[sys.executable, str(expert_script)],
            ), mock.patch(
                "tools.fable5.verify.build_refute_command",
                return_value=[sys.executable, str(refute_script)],
            ), mock.patch("shutil.which", return_value=sys.executable):
                first = await run_experts(
                    root=root,
                    report_dir=root / "report1",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                )
                second = await run_experts(
                    root=root,
                    report_dir=root / "report2",
                    agents=["security"],
                    model="sonnet",
                    changed_files=[],
                    deterministic_results=[],
                    workers=1,
                    timeout_seconds=10,
                )
            self.assertEqual(int(counter_path.read_text()), 1, "subprocess must run only once")
            self.assertEqual(first[0].status, "failed")
            self.assertEqual(second[0].status, "failed")
            self.assertIn("cached", second[0].reason)


if __name__ == "__main__":
    unittest.main()
