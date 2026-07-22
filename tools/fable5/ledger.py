from __future__ import annotations

import hashlib
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .verify import VerifiedFinding

# Bump this whenever the expert JSON findings prompt contract shape changes; it is folded into
# the expert_cache packet_key so a prompt-contract change invalidates old cached responses.
PROMPT_TEMPLATE_VERSION = "v1"

# How many runs a suppressed (refuted minor) finding stays hidden before it is re-verified again.
_SUPPRESSION_RUN_WINDOW = 10

_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF_SECONDS = 0.05


def _retry_write(connection: sqlite3.Connection, fn) -> object:
    """Run a write callback against connection with a small retry/backoff on lock contention."""
    last_error: sqlite3.OperationalError | None = None
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            result = fn()
            connection.commit()
            return result
        except sqlite3.OperationalError as error:
            last_error = error
            if "locked" not in str(error).lower() and "busy" not in str(error).lower():
                raise
            time.sleep(_RETRY_BACKOFF_SECONDS * (attempt + 1))
    assert last_error is not None
    raise last_error


def open_ledger(root: Path) -> sqlite3.Connection:
    """Open (creating if needed) the findings ledger at <root>/.fable5/ledger.sqlite3."""
    path = root / ".fable5" / "ledger.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute(
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
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS expert_cache (
            packet_key TEXT PRIMARY KEY,
            response TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def next_run(connection: sqlite3.Connection) -> int:
    """Increment and return the monotonic run counter stored in the meta table."""

    def _update() -> int:
        row = connection.execute(
            "SELECT value FROM meta WHERE key = 'run_counter'"
        ).fetchone()
        current = row[0] if row else 0
        new_value = current + 1
        connection.execute(
            "INSERT INTO meta(key, value) VALUES ('run_counter', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (new_value,),
        )
        return new_value

    return _retry_write(connection, _update)  # type: ignore[return-value]


def _normalize_claim(claim: str) -> str:
    return " ".join(claim.lower().split())


def fingerprint_for(angle: str, file: str, claim: str) -> str:
    material = f"{angle}|{file}|{_normalize_claim(claim)}"
    return hashlib.sha1(material.encode("utf-8")).hexdigest()


def cache_key_for(angle: str, packet_text: str) -> str:
    material = f"{angle}{PROMPT_TEMPLATE_VERSION}{packet_text}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def get_cached_response(connection: sqlite3.Connection, angle: str, packet_text: str) -> str | None:
    key = cache_key_for(angle, packet_text)
    row = connection.execute(
        "SELECT response FROM expert_cache WHERE packet_key = ?", (key,)
    ).fetchone()
    return row[0] if row else None


def put_cached_response(connection: sqlite3.Connection, angle: str, packet_text: str, response: str) -> None:
    key = cache_key_for(angle, packet_text)
    now = datetime.now(timezone.utc).isoformat()

    def _write() -> None:
        connection.execute(
            "INSERT OR REPLACE INTO expert_cache(packet_key, response, created_at) VALUES (?, ?, ?)",
            (key, response, now),
        )

    _retry_write(connection, _write)


@dataclass
class LedgerOutcome:
    suppressed: list[str] = field(default_factory=list)
    contested: list[str] = field(default_factory=list)
    promotions: list[str] = field(default_factory=list)
    visible: list["VerifiedFinding"] = field(default_factory=list)


def apply_run(
    connection: sqlite3.Connection, run_no: int, verified: list["VerifiedFinding"]
) -> LedgerOutcome:
    """Upsert each verified finding into the ledger and compute this run's outcome.

    Suppression math (exact): only minor-severity REFUTED findings auto-suppress
    (suppressed_until_run = run_no + 10). A suppressed fingerprint reappearing before that run is
    dropped from results (counted in `suppressed`). Refuted blocker/major findings are NEVER
    suppressed: they get status "contested" and surface with reason "contested - human review".
    Promotion: status confirmed AND seen_count >= 2 -> a promotion proposal string.
    """
    outcome = LedgerOutcome()
    now = datetime.now(timezone.utc).isoformat()

    def _apply() -> None:
        for item in verified:
            fingerprint = fingerprint_for(item.angle, item.file, item.claim)
            existing = connection.execute(
                "SELECT seen_count, suppressed_until_run FROM findings WHERE fingerprint = ?",
                (fingerprint,),
            ).fetchone()

            if existing is not None:
                existing_seen_count, suppressed_until_run = existing
                if suppressed_until_run is not None and run_no < suppressed_until_run:
                    # Still inside the suppression window: drop silently from visible results,
                    # but record the sighting was counted (not lost without a trace).
                    connection.execute(
                        "UPDATE findings SET last_seen = ?, seen_count = seen_count + 1, "
                        "run_counter = ? WHERE fingerprint = ?",
                        (now, run_no, fingerprint),
                    )
                    outcome.suppressed.append(fingerprint)
                    continue
                seen_count = existing_seen_count + 1
            else:
                seen_count = 1

            status = item.verified_status
            suppressed_until_run_new: int | None = None
            if item.verified_status == "refuted" and item.severity == "minor":
                status = "refuted"
                suppressed_until_run_new = run_no + _SUPPRESSION_RUN_WINDOW
            elif item.verified_status == "refuted" and item.severity in {"blocker", "major"}:
                status = "contested"
                outcome.contested.append(fingerprint)

            if existing is not None:
                connection.execute(
                    """
                    UPDATE findings
                    SET angle = ?, file = ?, claim = ?, severity = ?, status = ?,
                        last_seen = ?, seen_count = ?, suppressed_until_run = ?, run_counter = ?
                    WHERE fingerprint = ?
                    """,
                    (
                        item.angle,
                        item.file,
                        item.claim,
                        item.severity,
                        status,
                        now,
                        seen_count,
                        suppressed_until_run_new,
                        run_no,
                        fingerprint,
                    ),
                )
            else:
                connection.execute(
                    """
                    INSERT INTO findings(
                        fingerprint, angle, file, claim, severity, status,
                        first_seen, last_seen, seen_count, suppressed_until_run, run_counter
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        fingerprint,
                        item.angle,
                        item.file,
                        item.claim,
                        item.severity,
                        status,
                        now,
                        now,
                        seen_count,
                        suppressed_until_run_new,
                        run_no,
                    ),
                )

            if item.verified_status == "confirmed" and seen_count >= 2:
                outcome.promotions.append(
                    f"promote to deterministic rule: {item.angle}/{item.file}: {item.claim}"
                )

            outcome.visible.append(item)

    _retry_write(connection, _apply)
    return outcome
