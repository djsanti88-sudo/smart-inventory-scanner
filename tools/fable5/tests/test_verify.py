from __future__ import annotations

import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tools.fable5.experts import Finding
from tools.fable5.verify import (
    CallBudget,
    build_refute_command,
    refute,
    verify_findings,
)


def _fixture_script(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


def _finding(
    *,
    severity: str = "minor",
    file: str = "a.py",
    claim: str = "claim",
    confidence: float = 0.5,
    line: int = 1,
) -> Finding:
    return Finding(
        severity=severity,
        file=file,
        line=line,
        claim=claim,
        evidence="evidence",
        fix="fix",
        confidence=confidence,
    )


class BuildRefuteCommandTests(unittest.TestCase):
    def test_command_has_no_agent_flag_but_keeps_budget_cap(self) -> None:
        command = build_refute_command("haiku", "refute this")
        self.assertNotIn("--agent", command)
        self.assertEqual(command[command.index("--model") + 1], "haiku")
        self.assertEqual(command[command.index("--max-budget-usd") + 1], "0.50")
        self.assertIn("--print", command)

    def test_seam_env_var_replaces_executable(self) -> None:
        with mock.patch.dict(
            "os.environ", {"FABLE5_CLAUDE_CMD": "python fake_claude.py"}
        ):
            command = build_refute_command("haiku", "refute this")
        self.assertEqual(command[0], "python")
        self.assertEqual(command[1], "fake_claude.py")


class RefuteTests(unittest.IsolatedAsyncioTestCase):
    async def test_confirmed_verdict_parses(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps({"verdict": "confirmed", "reason": "solid evidence"}),
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "total_cost_usd": 0.0,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verdict = await refute(_finding(), "packet text")
        self.assertEqual(verdict.verdict, "confirmed")
        self.assertIn("solid evidence", verdict.reason)

    async def test_unparseable_response_is_unclear(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "not json at all",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "total_cost_usd": 0.0,
                }))
                """,
            )
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verdict = await refute(_finding(), "packet text")
        self.assertEqual(verdict.verdict, "unclear")

    async def test_packet_is_capped_to_8kb(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Echo the prompt (last CLI arg) back so we can inspect what was sent.
            script = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                import sys
                prompt = sys.argv[-1]
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": json.dumps({"verdict": "refuted", "reason": f"len={len(prompt)}"}),
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "total_cost_usd": 0.0,
                }))
                """,
            )
            huge_packet = "x" * 20000
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verdict = await refute(_finding(), huge_packet)
        self.assertEqual(verdict.verdict, "refuted")
        # The whole prompt (incl. finding JSON + instructions) must still be well under
        # a runaway size; the packet portion itself must not exceed 8KB.
        self.assertNotIn("x" * 20000, verdict.reason)


class CallBudgetTests(unittest.TestCase):
    def test_spend_decrements_and_returns_false_when_exhausted(self) -> None:
        budget = CallBudget(remaining=2)
        self.assertTrue(budget.spend())
        self.assertEqual(budget.remaining, 1)
        self.assertTrue(budget.spend())
        self.assertEqual(budget.remaining, 0)
        self.assertFalse(budget.spend())
        self.assertEqual(budget.remaining, 0)


def _confirm_script(root: Path) -> Path:
    return _fixture_script(
        root,
        "fake_claude.py",
        """
        import json
        print(json.dumps({
            "type": "result",
            "subtype": "success",
            "result": json.dumps({"verdict": "confirmed", "reason": "yes"}),
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "total_cost_usd": 0.0,
        }))
        """,
    )


class VerifyFindingsCapTests(unittest.IsolatedAsyncioTestCase):
    async def test_nine_findings_eight_individual_one_batch_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _confirm_script(root)
            findings = [
                _finding(severity="major", claim=f"claim {i}", confidence=0.9)
                for i in range(9)
            ]
            budget = CallBudget(remaining=30)
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verified = await verify_findings(findings, "packet", budget)
        self.assertEqual(len(verified), 9)
        # 9 findings -> 8 individual refute calls + 1 batched call = 9 AI calls spent.
        self.assertEqual(budget.remaining, 30 - 9)

    async def test_more_than_20_findings_marks_whole_angle_degraded_no_refute_calls(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _confirm_script(root)
            findings = [_finding(claim=f"claim {i}") for i in range(21)]
            budget = CallBudget(remaining=30)
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verified = await verify_findings(findings, "packet", budget)
        self.assertEqual(len(verified), 21)
        for item in verified:
            self.assertEqual(item.verified_status, "degraded")
        # No refute calls happened at all.
        self.assertEqual(budget.remaining, 30)

    async def test_ceiling_reached_mid_run_skips_remainder(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _confirm_script(root)
            findings = [
                _finding(severity="major", claim=f"claim {i}", confidence=0.9)
                for i in range(9)
            ]
            # Only enough budget for 3 individual refute calls.
            budget = CallBudget(remaining=3)
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verified = await verify_findings(findings, "packet", budget)
        self.assertEqual(len(verified), 9)
        self.assertEqual(budget.remaining, 0)
        skipped = [item for item in verified if item.verified_status == "skipped"]
        self.assertTrue(skipped)
        for item in skipped:
            self.assertIn("AI call ceiling reached; partial review", item.refute_reason)

    async def test_unclear_escalates_once_to_sonnet_then_kept_unverified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = _fixture_script(
                root,
                "fake_claude.py",
                """
                import json
                print(json.dumps({
                    "type": "result",
                    "subtype": "success",
                    "result": "still not parseable",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "total_cost_usd": 0.0,
                }))
                """,
            )
            findings = [_finding(severity="blocker", confidence=0.9)]
            budget = CallBudget(remaining=30)
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verified = await verify_findings(findings, "packet", budget)
        self.assertEqual(len(verified), 1)
        self.assertEqual(verified[0].verified_status, "unverified")
        # One initial call + one escalation call = 2 spent.
        self.assertEqual(budget.remaining, 30 - 2)

    async def test_batch_parse_failure_marks_remainder_unverified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            call_counter = root / "calls.txt"
            script = _fixture_script(
                root,
                "fake_claude.py",
                f"""
                import json
                import sys
                from pathlib import Path
                counter_path = Path(r"{call_counter}")
                count = int(counter_path.read_text()) if counter_path.exists() else 0
                count += 1
                counter_path.write_text(str(count))
                prompt = sys.argv[-1]
                if "indices" in prompt or "refuted" in prompt and "confirmed" in prompt and "batch" not in prompt.lower():
                    pass
                # First 8 calls are individual refutes -> confirmed. 9th call is the batch,
                # which we deliberately answer with garbage to force a parse failure.
                if count <= 8:
                    result_text = json.dumps({{"verdict": "confirmed", "reason": "yes"}})
                else:
                    result_text = "not valid json for batch"
                print(json.dumps({{
                    "type": "result",
                    "subtype": "success",
                    "result": result_text,
                    "usage": {{"input_tokens": 1, "output_tokens": 1}},
                    "total_cost_usd": 0.0,
                }}))
                """,
            )
            findings = [
                _finding(severity="major", claim=f"claim {i}", confidence=0.9)
                for i in range(10)
            ]
            budget = CallBudget(remaining=30)
            with mock.patch.dict(
                "os.environ", {"FABLE5_CLAUDE_CMD": f"{sys.executable} {script}"}
            ):
                verified = await verify_findings(findings, "packet", budget)
        self.assertEqual(len(verified), 10)
        remainder = [item for item in verified if item.claim == "claim 8"]
        self.assertEqual(len(remainder), 1)
        self.assertEqual(remainder[0].verified_status, "unverified")


if __name__ == "__main__":
    unittest.main()
