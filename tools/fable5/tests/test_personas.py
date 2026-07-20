from __future__ import annotations

import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tools.fable5.cli import _hook_triggered_refusal, _personas_requested, build_parser
from tools.fable5.personas import (
    PERSONA_RUNS,
    PersonaMetric,
    build_persona_prompt,
    load_metrics,
    run_persona_judgments,
)


def _write_script(directory: Path, name: str, body: str) -> Path:
    path = directory / name
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


class MetricsTests(unittest.TestCase):
    def test_loads_driver_metrics_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metrics_path = Path(temporary) / "metrics.json"
            metrics_path.write_text(
                json.dumps(
                    [
                        {
                            "flow": "scan-known-x5",
                            "ms": 125.5,
                            "steps": 5,
                            "failures": [],
                            "screenshot": "personas/screenshots/scan-known-x5.png",
                        },
                        {
                            "flow": "scan-unknown",
                            "ms": 80,
                            "steps": 1,
                            "failures": ["example failure"],
                            "screenshot": "personas/screenshots/scan-unknown.png",
                        },
                    ]
                ),
                encoding="utf-8",
            )

            metrics = load_metrics(metrics_path)

        self.assertEqual(
            metrics[0],
            PersonaMetric(
                flow="scan-known-x5",
                ms=125.5,
                steps=5,
                failures=(),
                screenshot="personas/screenshots/scan-known-x5.png",
            ),
        )
        self.assertEqual(metrics[1].failures, ("example failure",))

    def test_rejects_missing_or_wrong_metric_fields(self) -> None:
        bad_payloads = [
            {"flow": "one"},
            [{"flow": "one", "ms": -1, "steps": 1, "failures": [], "screenshot": "x.png"}],
            [{"flow": "one", "ms": 1, "steps": 0, "failures": [], "screenshot": "x.png"}],
            [{"flow": "one", "ms": 1, "steps": 1, "failures": "none", "screenshot": "x.png"}],
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "metrics.json"
                path.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_metrics(path)

    def test_prompt_appends_measured_evidence_and_150_month_question(self) -> None:
        metrics = [
            PersonaMetric(
                flow="export-csv",
                ms=210.0,
                steps=2,
                failures=(),
                screenshot="reports/fable5/run/personas/screenshots/export-csv.png",
            )
        ]

        prompt = build_persona_prompt("value-roi", "shop owner", metrics)

        self.assertIn('"flow": "export-csv"', prompt)
        self.assertIn("reports/fable5/run/personas/screenshots/export-csv.png", prompt)
        self.assertIn("$150/month", prompt)
        self.assertIn('"buy": "yes|no|maybe"', prompt)
        self.assertIn('"price_ok": true', prompt)
        self.assertIn('"top_missing": []', prompt)
        self.assertIn('"misfits": []', prompt)
        self.assertIn("existing value-roi agent contract", prompt)


class PersonaDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_three_sonnet_calls_reuse_existing_agents_through_stub_seam(self) -> None:
        self.assertEqual(
            PERSONA_RUNS,
            (
                ("value-roi", "shop owner"),
                ("ux-vision", "No-training clerk"),
                ("ux-vision", "Busy manager"),
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_dir = root / "report"
            calls_path = root / "calls.jsonl"
            auth_script = _write_script(
                root,
                "auth.py",
                """
                import json
                print(json.dumps({"authMethod": "claude.ai", "subscriptionType": "max"}))
                """,
            )
            claude_script = _write_script(
                root,
                "claude.py",
                f"""
                import json
                import sys
                from pathlib import Path

                call = {{"argv": sys.argv[1:]}}
                with Path({str(calls_path)!r}).open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(call) + "\\n")
                verdict = {{
                    "buy": "maybe",
                    "price_ok": False,
                    "top_missing": ["faster review"],
                    "misfits": [],
                }}
                result = "agent output\\npurchase_verdict: " + json.dumps(verdict)
                print(json.dumps({{
                    "result": result,
                    "usage": {{"input_tokens": 10, "output_tokens": 5}},
                    "total_cost_usd": 0,
                }}))
                """,
            )
            metrics = [
                PersonaMetric(
                    flow="view-counts",
                    ms=10,
                    steps=1,
                    failures=(),
                    screenshot="counts.png",
                )
            ]
            with mock.patch.dict(
                "os.environ",
                {
                    "FABLE5_AUTH_STATUS_CMD": f"{sys.executable} {auth_script}",
                    "FABLE5_CLAUDE_CMD": f"{sys.executable} {claude_script}",
                },
            ):
                results = await run_persona_judgments(
                    root=root,
                    report_dir=report_dir,
                    metrics=metrics,
                    model="sonnet",
                    timeout_seconds=30,
                )

            calls = [json.loads(line) for line in calls_path.read_text(encoding="utf-8").splitlines()]
            written = json.loads(
                (report_dir / "personas" / "judgments.json").read_text(encoding="utf-8")
            )

        self.assertEqual(len(results), 3)
        self.assertTrue(all(result.status == "passed" for result in results))
        self.assertEqual(
            [call["argv"][call["argv"].index("--agent") + 1] for call in calls],
            ["value-roi", "ux-vision", "ux-vision"],
        )
        self.assertTrue(all(call["argv"][call["argv"].index("--model") + 1] == "sonnet" for call in calls))
        self.assertEqual(len(written), 3)
        self.assertEqual(written[0]["verdict"]["buy"], "maybe")


class PersonaCliTests(unittest.TestCase):
    def test_review_build_accepts_personas_flag(self) -> None:
        args = build_parser().parse_args(["review-build", "--personas"])
        self.assertTrue(args.personas)
        self.assertTrue(_personas_requested(args))

    def test_monthly_gate_enables_personas_by_default(self) -> None:
        args = build_parser().parse_args(["review-build", "--gate", "monthly"])
        self.assertFalse(args.personas)
        self.assertTrue(_personas_requested(args))

    def test_hook_triggered_personas_are_refused(self) -> None:
        args = build_parser().parse_args(["review-build", "--personas"])
        self.assertEqual(
            _hook_triggered_refusal(args),
            "hook-triggered runs are deterministic-only: --personas refused",
        )


class PersonaDriverContractTests(unittest.TestCase):
    def test_driver_has_required_flows_port_and_metric_fields(self) -> None:
        driver = Path(__file__).resolve().parents[3] / "e2e" / "persona-drive.mjs"
        text = driver.read_text(encoding="utf-8")
        for required in (
            "http://localhost:3400",
            "scan-known-x5",
            "scan-unknown",
            "resolve-needs-review",
            "view-counts",
            "export-csv",
            "flow",
            "ms",
            "steps",
            "failures",
            "screenshot",
        ):
            self.assertIn(required, text)


if __name__ == "__main__":
    unittest.main()
