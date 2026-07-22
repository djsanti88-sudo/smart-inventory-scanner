from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.fable5.cli import _hook_triggered_refusal, build_parser
from tools.fable5.stress import (
    INTENSITIES,
    MAX_SCANS_PER_SECOND,
    StressFixtureError,
    StressSafetyError,
    StressSafetyMonitor,
    assert_daily_cap_available,
    execute_stress,
    load_and_validate_fixture,
    minimum_throttle_delay,
    validate_target,
    validate_unknown_scans,
)


def _make_corpus(path: Path, codes: list[str]) -> None:
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE tires (barcode TEXT PRIMARY KEY, usable_for TEXT, current_status TEXT)"
    )
    connection.executemany(
        "INSERT INTO tires (barcode, usable_for, current_status) VALUES (?, ?, ?)",
        [(code, "auto_count_candidate", "active_retail") for code in codes],
    )
    connection.commit()
    connection.close()


class TargetRailTests(unittest.TestCase):
    def test_localhost_port_3400_is_allowed_without_cloud_flag(self) -> None:
        policy = validate_target("http://localhost:3400", allow_cloud=False)
        self.assertTrue(policy.local)
        self.assertTrue(policy.route_mock)

    def test_non_localhost_is_refused_without_allow_cloud(self) -> None:
        with self.assertRaisesRegex(StressSafetyError, "--allow-cloud"):
            validate_target("https://preview.example.test", allow_cloud=False)

    def test_non_localhost_is_allowed_only_with_explicit_cloud_flag(self) -> None:
        policy = validate_target("https://preview.example.test", allow_cloud=True)
        self.assertFalse(policy.local)
        self.assertFalse(policy.route_mock)

    def test_execute_refuses_before_starting_driver(self) -> None:
        with mock.patch("tools.fable5.stress.subprocess.run") as run:
            with self.assertRaises(StressSafetyError):
                execute_stress(
                    root=Path.cwd(),
                    target="https://preview.example.test",
                    intensity="light",
                    allow_cloud=False,
                    unknown_scans=0,
                )
        run.assert_not_called()


class RequestAndCapRailTests(unittest.TestCase):
    def test_ai_lookup_request_trips_with_offending_scan(self) -> None:
        monitor = StressSafetyMonitor()
        with self.assertRaisesRegex(StressSafetyError, "OFFENDING-CODE"):
            monitor.observe_request(
                "http://localhost:3400/api/ai-lookup?mode=decode",
                scan="OFFENDING-CODE",
            )

    def test_unrelated_request_does_not_trip(self) -> None:
        monitor = StressSafetyMonitor()
        monitor.observe_request("http://localhost:3400/scan", scan="SAFE")
        self.assertEqual(monitor.ai_lookup_requests, 0)

    def test_first_429_trips_immediately(self) -> None:
        monitor = StressSafetyMonitor()
        with self.assertRaisesRegex(StressSafetyError, "429"):
            monitor.observe_response(429, scan="RATE-LIMITED")
        self.assertEqual(monitor.rate_limit_responses, 1)

    def test_daily_cap_is_checked_fail_closed_before_batch(self) -> None:
        assert_daily_cap_available(used=499, limit=500)
        with self.assertRaisesRegex(StressSafetyError, "daily cap"):
            assert_daily_cap_available(used=500, limit=500)
        with self.assertRaisesRegex(StressSafetyError, "could not be read"):
            assert_daily_cap_available(used=None, limit=500)

    def test_throttle_never_exceeds_five_scans_per_second(self) -> None:
        self.assertEqual(MAX_SCANS_PER_SECOND, 5)
        self.assertAlmostEqual(minimum_throttle_delay(scans=5, elapsed_seconds=0.4), 0.6)
        self.assertEqual(minimum_throttle_delay(scans=5, elapsed_seconds=1.2), 0)


class FixtureRailTests(unittest.TestCase):
    def test_exactly_40_unique_fixture_codes_revalidate_against_corpus(self) -> None:
        codes = [f"{index:012d}" for index in range(1, 41)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "stress-codes.json"
            corpus = root / "knowledge.db"
            fixture.write_text(
                json.dumps({"source": "test corpus", "codes": codes}), encoding="utf-8"
            )
            _make_corpus(corpus, codes)

            loaded = load_and_validate_fixture(fixture, corpus)

        self.assertEqual(loaded, codes)

    def test_fixture_aborts_when_any_code_no_longer_resolves(self) -> None:
        codes = [f"{index:012d}" for index in range(1, 41)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "stress-codes.json"
            corpus = root / "knowledge.db"
            fixture.write_text(
                json.dumps({"source": "test corpus", "codes": codes}), encoding="utf-8"
            )
            _make_corpus(corpus, codes[:-1])

            with self.assertRaisesRegex(StressFixtureError, codes[-1]):
                load_and_validate_fixture(fixture, corpus)

    def test_fixture_aborts_when_code_loses_deterministic_status(self) -> None:
        codes = [f"{index:012d}" for index in range(1, 41)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "stress-codes.json"
            corpus = root / "knowledge.db"
            fixture.write_text(
                json.dumps({"source": "test corpus", "codes": codes}), encoding="utf-8"
            )
            _make_corpus(corpus, codes)
            connection = sqlite3.connect(corpus)
            connection.execute(
                "UPDATE tires SET usable_for = 'review_candidate' WHERE barcode = ?", (codes[-1],)
            )
            connection.commit()
            connection.close()

            with self.assertRaisesRegex(StressFixtureError, codes[-1]):
                load_and_validate_fixture(fixture, corpus)

    def test_fixture_rejects_wrong_count_or_duplicates(self) -> None:
        codes = [f"{index:012d}" for index in range(1, 40)] + ["000000000001"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = root / "stress-codes.json"
            corpus = root / "knowledge.db"
            fixture.write_text(
                json.dumps({"source": "test corpus", "codes": codes}), encoding="utf-8"
            )
            _make_corpus(corpus, list(dict.fromkeys(codes)))
            with self.assertRaisesRegex(StressFixtureError, "40 unique"):
                load_and_validate_fixture(fixture, corpus)

    def test_repository_fixture_contains_40_real_corpus_codes(self) -> None:
        root = Path(__file__).resolve().parents[3]
        codes = load_and_validate_fixture(
            root / "tools" / "fable5" / "fixtures" / "stress-codes.json",
            root / "src" / "server" / "knowledge.generated.db",
        )
        self.assertEqual(len(codes), 40)


class IntensityAndCliTests(unittest.TestCase):
    def test_intensities_match_light_and_standard_contracts(self) -> None:
        self.assertEqual(INTENSITIES["light"].scans, 100)
        self.assertEqual(INTENSITIES["light"].contexts, 1)
        self.assertEqual(INTENSITIES["standard"].scans, 300)
        self.assertEqual(INTENSITIES["standard"].contexts, 3)
        self.assertGreaterEqual(INTENSITIES["standard"].estimated_seconds, 540)
        self.assertLessEqual(INTENSITIES["standard"].estimated_seconds, 660)
        self.assertTrue(INTENSITIES["standard"].refresh_mid_session)
        self.assertTrue(INTENSITIES["standard"].offline_reconnect)

    def test_unknown_scans_default_zero_and_are_tightly_capped(self) -> None:
        self.assertEqual(validate_unknown_scans(0), 0)
        self.assertEqual(validate_unknown_scans(5), 5)
        with self.assertRaises(StressSafetyError):
            validate_unknown_scans(6)

        args = build_parser().parse_args(
            ["stress", "--target", "http://localhost:3400", "--intensity", "light"]
        )
        self.assertEqual(args.unknown_scans, 0)
        self.assertFalse(args.allow_cloud)

    def test_stress_is_refused_under_hook_triggered_environment(self) -> None:
        args = build_parser().parse_args(
            ["stress", "--target", "http://localhost:3400"]
        )
        self.assertEqual(
            _hook_triggered_refusal(args),
            "hook-triggered runs are deterministic-only: stress refused",
        )


class StressDriverContractTests(unittest.TestCase):
    def test_driver_contains_fail_closed_browser_rails_and_chaos_steps(self) -> None:
        driver = Path(__file__).resolve().parents[3] / "e2e" / "stress-drive.mjs"
        text = driver.read_text(encoding="utf-8")
        for required in (
            "--allow-cloud",
            "/api/ai-lookup",
            'context.on("request"',
            'context.on("response"',
            "route.fulfill",
            "status() === 429",
            "MAX_SCANS_PER_SECOND = 5",
            "unknownScans: 0",
            "assertDailyCap",
            "setOffline(true)",
            "setOffline(false)",
            ".reload(",
            "export-final-counts",
            "crown_invariant",
            "fixture_revalidated",
        ):
            self.assertIn(required, text)


if __name__ == "__main__":
    unittest.main()
