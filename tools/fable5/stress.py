from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


MAX_SCANS_PER_SECOND = 5
MAX_UNKNOWN_SCANS = 5


class StressSafetyError(ValueError):
    pass


class StressFixtureError(ValueError):
    pass


@dataclass(frozen=True)
class TargetPolicy:
    local: bool
    route_mock: bool


@dataclass(frozen=True)
class Intensity:
    scans: int
    contexts: int
    batch_size: int
    batch_pause_seconds: float
    estimated_seconds: int
    refresh_mid_session: bool
    offline_reconnect: bool
    timeout_seconds: int


@dataclass(frozen=True)
class StressExecution:
    returncode: int
    report_path: Path
    stdout: str


INTENSITIES: dict[str, Intensity] = {
    "light": Intensity(
        scans=100,
        contexts=1,
        batch_size=5,
        batch_pause_seconds=1,
        estimated_seconds=20,
        refresh_mid_session=False,
        offline_reconnect=False,
        timeout_seconds=600,
    ),
    "standard": Intensity(
        scans=300,
        contexts=3,
        batch_size=5,
        batch_pause_seconds=10,
        estimated_seconds=600,
        refresh_mid_session=True,
        offline_reconnect=True,
        timeout_seconds=1200,
    ),
    "heavy": Intensity(
        scans=1000,
        contexts=5,
        batch_size=5,
        batch_pause_seconds=10,
        estimated_seconds=2000,
        refresh_mid_session=True,
        offline_reconnect=True,
        timeout_seconds=3000,
    ),
}


def validate_target(target: str, *, allow_cloud: bool) -> TargetPolicy:
    try:
        parsed = urlparse(target)
        port = parsed.port
    except ValueError as error:
        raise StressSafetyError(f"Invalid stress target: {error}") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise StressSafetyError("Stress target must be an absolute HTTP or HTTPS URL")
    local = parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
    if local:
        if port != 3400:
            raise StressSafetyError("Local stress targets must use dedicated port 3400")
        return TargetPolicy(local=True, route_mock=True)
    if not allow_cloud:
        raise StressSafetyError("Non-localhost stress targets require explicit --allow-cloud")
    if parsed.scheme != "https":
        raise StressSafetyError("Cloud stress targets must use HTTPS")
    return TargetPolicy(local=False, route_mock=False)


def validate_unknown_scans(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise StressSafetyError("--unknown-scans must be a non-negative integer")
    if value > MAX_UNKNOWN_SCANS:
        raise StressSafetyError(
            f"--unknown-scans is capped at {MAX_UNKNOWN_SCANS}; requested {value}"
        )
    return value


def assert_daily_cap_available(*, used: int | None, limit: int | None) -> None:
    if used is None or limit is None:
        raise StressSafetyError("Shared daily cap could not be read before the batch")
    if used < 0 or limit < 0 or used >= limit:
        raise StressSafetyError(f"Shared daily cap unavailable: {used} of {limit} already used")


def minimum_throttle_delay(*, scans: int, elapsed_seconds: float) -> float:
    if scans < 0 or elapsed_seconds < 0:
        raise ValueError("scans and elapsed_seconds must be non-negative")
    return max(0.0, scans / MAX_SCANS_PER_SECOND - elapsed_seconds)


class StressSafetyMonitor:
    def __init__(self) -> None:
        self.ai_lookup_requests = 0
        self.rate_limit_responses = 0

    def observe_request(self, url: str, *, scan: str) -> None:
        path = urlparse(url).path.rstrip("/")
        if path == "/api/ai-lookup":
            self.ai_lookup_requests += 1
            raise StressSafetyError(
                f"/api/ai-lookup request detected; offending scan: {scan}"
            )

    def observe_response(self, status: int, *, scan: str) -> None:
        if status == 429:
            self.rate_limit_responses += 1
            raise StressSafetyError(f"429 detected; stopped on offending scan: {scan}")


def load_and_validate_fixture(fixture_path: Path, corpus_path: Path) -> list[str]:
    try:
        payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StressFixtureError(f"Could not read stress fixture: {error}") from error
    if not isinstance(payload, dict) or set(payload) != {"source", "codes"}:
        raise StressFixtureError("Stress fixture must contain exactly source and codes")
    if not isinstance(payload["source"], str) or not payload["source"].strip():
        raise StressFixtureError("Stress fixture source must be documented")
    codes = payload["codes"]
    if (
        not isinstance(codes, list)
        or len(codes) != 40
        or len(set(codes)) != 40
        or not all(isinstance(code, str) and code.isdigit() for code in codes)
    ):
        raise StressFixtureError("Stress fixture must contain exactly 40 unique numeric codes")
    if not corpus_path.is_file():
        raise StressFixtureError(f"Local corpus database is missing: {corpus_path}")

    uri = f"{corpus_path.resolve().as_uri()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
        placeholders = ",".join("?" for _ in codes)
        rows = connection.execute(
            (
                f"SELECT barcode FROM tires WHERE barcode IN ({placeholders}) "  # noqa: S608
                "AND usable_for = 'auto_count_candidate' AND current_status = 'active_retail'"
            ),
            codes,
        ).fetchall()
    except sqlite3.Error as error:
        raise StressFixtureError(f"Could not revalidate fixture against corpus: {error}") from error
    finally:
        if "connection" in locals():
            connection.close()
    resolved = {str(row[0]) for row in rows}
    missing = [code for code in codes if code not in resolved]
    if missing:
        raise StressFixtureError(
            "Stress fixture revalidation failed; corpus misses: " + ", ".join(missing)
        )
    return list(codes)


def _safe_environment() -> dict[str, str]:
    blocked = ("TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE_KEY")
    environment = {
        key: value
        for key, value in os.environ.items()
        if not any(fragment in key.upper() for fragment in blocked)
    }
    environment["NO_COLOR"] = "1"
    return environment


def execute_stress(
    *,
    root: Path,
    target: str,
    intensity: str = "standard",
    allow_cloud: bool = False,
    unknown_scans: int = 0,
    report_dir: Path | None = None,
) -> StressExecution:
    policy = validate_target(target, allow_cloud=allow_cloud)
    unknown_count = validate_unknown_scans(unknown_scans)
    try:
        selected = INTENSITIES[intensity]
    except KeyError as error:
        raise StressSafetyError(
            f"Unknown stress intensity {intensity!r}; choose light, standard, or heavy"
        ) from error

    fixture_path = root / "tools" / "fable5" / "fixtures" / "stress-codes.json"
    corpus_path = root / "src" / "decoding" / "server" / "knowledge" / "knowledge.generated.db"
    load_and_validate_fixture(fixture_path, corpus_path)

    if report_dir is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        report_dir = root / "reports" / "fable5" / f"{stamp}-stress"
    report_path = report_dir / "stress" / "report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "node",
        "e2e/stress-drive.mjs",
        "--target",
        target,
        "--intensity",
        intensity,
        "--unknown-scans",
        str(unknown_count),
        "--fixture",
        str(fixture_path),
        "--corpus",
        str(corpus_path),
        "--output",
        str(report_path),
    ]
    if not policy.local:
        command.append("--allow-cloud")
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            env=_safe_environment(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=selected.timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StressSafetyError(f"Stress driver could not complete: {error}") from error
    output = completed.stdout
    if completed.stderr:
        output = f"{output}\n{completed.stderr}".strip()
    return StressExecution(
        returncode=completed.returncode,
        report_path=report_path,
        stdout=output,
    )


def _validation_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tools.fable5.stress")
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate-fixture")
    validate.add_argument("--fixture", required=True)
    validate.add_argument("--corpus", required=True)
    args = parser.parse_args(argv)
    try:
        codes = load_and_validate_fixture(Path(args.fixture), Path(args.corpus))
    except StressFixtureError as error:
        print(f"fixture revalidation failed: {error}")
        return 1
    print(json.dumps({"fixture_revalidated": True, "codes": len(codes)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(_validation_cli())
