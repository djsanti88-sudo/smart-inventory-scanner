from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from tools.fable5.ledger import apply_run, next_run, open_ledger
from tools.fable5.verify import VerifiedFinding


def _verified(
    *,
    angle: str = "security",
    file: str = "a.py",
    claim: str = "some claim",
    severity: str = "minor",
    verified_status: str = "refuted",
    confidence: float = 0.5,
    line: int = 1,
    refute_reason: str = "",
) -> VerifiedFinding:
    return VerifiedFinding(
        severity=severity,
        file=file,
        line=line,
        claim=claim,
        evidence="evidence",
        fix="fix",
        confidence=confidence,
        verified_status=verified_status,
        refute_reason=refute_reason,
        angle=angle,
    )


class OpenLedgerTests(unittest.TestCase):
    def test_creates_db_with_wal_and_busy_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
                busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
                self.assertEqual(journal_mode.lower(), "wal")
                self.assertEqual(busy_timeout, 5000)
                tables = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                self.assertIn("findings", tables)
                self.assertIn("meta", tables)
                self.assertIn("expert_cache", tables)
            finally:
                conn.close()

    def test_db_file_created_under_dot_fable5(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            conn.close()
            self.assertTrue((root / ".fable5" / "ledger.sqlite3").exists())


class NextRunTests(unittest.TestCase):
    def test_run_counter_increments_monotonically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                first = next_run(conn)
                second = next_run(conn)
                third = next_run(conn)
                self.assertEqual([first, second, third], [1, 2, 3])
            finally:
                conn.close()


class ApplyRunSuppressionTests(unittest.TestCase):
    def test_minor_refuted_finding_suppresses_for_ten_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                run_no = next_run(conn)
                verified = [_verified(severity="minor", verified_status="refuted")]
                outcome = apply_run(conn, run_no, verified)
                self.assertEqual(len(outcome.suppressed), 0)  # first sighting, not suppressed yet
                row = conn.execute(
                    "SELECT suppressed_until_run FROM findings"
                ).fetchone()
                self.assertEqual(row[0], run_no + 10)

                # Reappears on the very next run, before suppressed_until_run: dropped.
                run_2 = next_run(conn)
                outcome_2 = apply_run(conn, run_2, verified)
                self.assertEqual(len(outcome_2.suppressed), 1)
                self.assertEqual(len(outcome_2.contested), 0)
            finally:
                conn.close()

    def test_suppression_expires_after_ten_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                run_no = next_run(conn)
                verified = [_verified(severity="minor", verified_status="refuted")]
                apply_run(conn, run_no, verified)
                last_run = run_no
                for _ in range(10):
                    last_run = next_run(conn)
                    outcome = apply_run(conn, last_run, verified)
                # By run_no + 10, suppression has expired: no longer auto-dropped.
                self.assertEqual(len(outcome.suppressed), 0)
            finally:
                conn.close()

    def test_refuted_blocker_is_never_suppressed_and_is_contested(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                run_no = next_run(conn)
                verified = [_verified(severity="blocker", verified_status="refuted")]
                outcome = apply_run(conn, run_no, verified)
                self.assertEqual(len(outcome.contested), 1)
                row = conn.execute(
                    "SELECT suppressed_until_run, status FROM findings"
                ).fetchone()
                self.assertIsNone(row[0])
                self.assertEqual(row[1], "contested")

                run_2 = next_run(conn)
                outcome_2 = apply_run(conn, run_2, verified)
                # Never suppressed: reappears as contested again, not dropped.
                self.assertEqual(len(outcome_2.suppressed), 0)
                self.assertEqual(len(outcome_2.contested), 1)
            finally:
                conn.close()

    def test_refuted_major_is_never_suppressed_and_is_contested(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                run_no = next_run(conn)
                verified = [_verified(severity="major", verified_status="refuted")]
                outcome = apply_run(conn, run_no, verified)
                self.assertEqual(len(outcome.contested), 1)
            finally:
                conn.close()


class ApplyRunPromotionTests(unittest.TestCase):
    def test_confirmed_finding_seen_twice_yields_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                verified = [
                    _verified(
                        angle="security",
                        file="a.py",
                        claim="sql injection risk",
                        severity="blocker",
                        verified_status="confirmed",
                    )
                ]
                run_1 = next_run(conn)
                outcome_1 = apply_run(conn, run_1, verified)
                self.assertEqual(len(outcome_1.promotions), 0)

                run_2 = next_run(conn)
                outcome_2 = apply_run(conn, run_2, verified)
                self.assertEqual(len(outcome_2.promotions), 1)
                self.assertIn("promote to deterministic rule:", outcome_2.promotions[0])
                self.assertIn("security/a.py", outcome_2.promotions[0])
                self.assertIn("sql injection risk", outcome_2.promotions[0])
            finally:
                conn.close()

    def test_seen_count_increments_on_each_reappearance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            conn = open_ledger(root)
            try:
                verified = [_verified(verified_status="confirmed", severity="major")]
                run_1 = next_run(conn)
                apply_run(conn, run_1, verified)
                run_2 = next_run(conn)
                apply_run(conn, run_2, verified)
                row = conn.execute("SELECT seen_count FROM findings").fetchone()
                self.assertEqual(row[0], 2)
            finally:
                conn.close()


class _FlakyConnection(sqlite3.Connection):
    """A sqlite3.Connection subclass whose first INSERT raises 'database is locked' once,
    to prove the retry-wrapped write path in ledger.py recovers instead of raising."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._locked_once = False

    def execute(self, sql, *args, **kwargs):  # type: ignore[override]
        if not self._locked_once and sql.strip().upper().startswith("INSERT"):
            self._locked_once = True
            raise sqlite3.OperationalError("database is locked")
        return super().execute(sql, *args, **kwargs)


class RetryWrappedWriteTests(unittest.TestCase):
    def test_write_survives_transient_locked_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db_path = root / ".fable5" / "ledger.sqlite3"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(db_path, factory=_FlakyConnection)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS findings (
                    fingerprint TEXT PRIMARY KEY,
                    angle TEXT NOT NULL,
                    file TEXT NOT NULL,
                    claim TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    status TEXT NOT NULL,
                    first_seen TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    seen_count INTEGER NOT NULL DEFAULT 0,
                    suppressed_until_run INTEGER,
                    run_counter INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)"
            )
            conn.commit()
            try:
                run_no = next_run(conn)
                verified = [_verified()]
                # Should not raise despite the first INSERT attempt failing with "locked".
                apply_run(conn, run_no, verified)
                row = conn.execute("SELECT COUNT(*) FROM findings").fetchone()
                self.assertEqual(row[0], 1)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
