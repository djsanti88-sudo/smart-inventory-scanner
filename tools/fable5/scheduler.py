from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .cache import EvidenceCache
from .config import FableConfig
from .discovery import matches_changed_paths
from .models import CheckResult, CheckSpec
from .verdict import redact_secrets


@dataclass(frozen=True)
class SafetyPolicy:
    allow_network: bool = False
    allow_live: bool = False
    allow_paid: bool = False
    allow_mutating: bool = False


EventCallback = Callable[[str], None]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_environment() -> dict[str, str]:
    blocked_fragments = ("TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE_KEY")
    environment = {
        key: value
        for key, value in os.environ.items()
        if not any(fragment in key.upper() for fragment in blocked_fragments)
    }
    environment["CI"] = "1"
    environment["NO_COLOR"] = "1"
    return environment


def _normalized_executable(command: str) -> str:
    name = Path(command).name.lower()
    for suffix in (".exe", ".cmd", ".bat"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _resolved_command(spec: CheckSpec, allowed: frozenset[str]) -> tuple[list[str] | None, str]:
    executable = _normalized_executable(spec.command[0])
    if executable not in allowed:
        return None, f"Executable {executable!r} is not in the command allowlist"
    resolved = shutil.which(spec.command[0])
    if not resolved:
        return None, f"Executable {spec.command[0]!r} is not installed"
    return [resolved, *spec.command[1:]], ""


def _safety_reason(spec: CheckSpec, policy: SafetyPolicy) -> str:
    blocked: list[str] = []
    if spec.network and not policy.allow_network:
        blocked.append("network")
    if spec.live and not policy.allow_live:
        blocked.append("live system")
    if spec.paid and not policy.allow_paid:
        blocked.append("paid API")
    if spec.mutating and not policy.allow_mutating:
        blocked.append("mutating action")
    return f"Safety gate blocked: {', '.join(blocked)}" if blocked else ""


async def _stream_output(
    process: asyncio.subprocess.Process,
    log_path: Path,
    tail_limit: int = 64 * 1024,
) -> str:
    output = bytearray()
    assert process.stdout is not None
    while True:
        chunk = await process.stdout.read(8192)
        if not chunk:
            break
        output.extend(chunk)
    redacted = redact_secrets(output.decode("utf-8", errors="replace"))
    log_path.write_text(redacted, encoding="utf-8")
    return redacted.encode("utf-8")[-tail_limit:].decode("utf-8", errors="replace")


async def _execute(
    spec: CheckSpec,
    command: list[str],
    root: Path,
    log_path: Path,
) -> tuple[int | None, float, str, str]:
    start = time.perf_counter()
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=root,
        env=_safe_environment(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=creationflags,
        start_new_session=os.name != "nt",
    )
    reader = asyncio.create_task(_stream_output(process, log_path))
    reason = ""
    try:
        await asyncio.wait_for(process.wait(), timeout=spec.timeout_seconds)
    except TimeoutError:
        reason = f"Timed out after {spec.timeout_seconds} seconds"
        process.kill()
        await process.wait()
    output_tail = await reader
    return process.returncode, time.perf_counter() - start, output_tail, reason


async def run_checks(
    *,
    root: Path,
    config: FableConfig,
    gate: str,
    report_dir: Path,
    changed_files: list[str],
    workspace_key: str,
    cache: EvidenceCache,
    policy: SafetyPolicy,
    only: set[str] | None = None,
    dry_run: bool = False,
    callback: EventCallback = print,
) -> list[CheckResult]:
    selected = {
        spec.check_id: spec
        for spec in config.checks
        if gate in spec.gates and (not only or spec.check_id in only)
    }
    logs_dir = report_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    semaphores = {
        "light": asyncio.Semaphore(config.light_workers),
        "heavy": asyncio.Semaphore(config.heavy_workers),
        "browser": asyncio.Semaphore(config.browser_workers),
    }
    tasks: dict[str, asyncio.Task[CheckResult]] = {}

    async def run_one(spec: CheckSpec) -> CheckResult:
        for dependency in spec.depends_on:
            dependency_task = tasks.get(dependency)
            if dependency_task is None:
                continue
            dependency_result = await dependency_task
            if dependency_result.status in {"failed", "blocked"}:
                return CheckResult(
                    check_id=spec.check_id,
                    description=spec.description,
                    status="skipped",
                    blocking=spec.blocking,
                    command=list(spec.command),
                    started_at=_now(),
                    reason=f"Dependency {dependency!r} did not pass",
                )

        if spec.paths and not spec.always_run and not matches_changed_paths(spec.paths, changed_files):
            return CheckResult(
                check_id=spec.check_id,
                description=spec.description,
                status="skipped",
                blocking=spec.blocking,
                command=list(spec.command),
                started_at=_now(),
                reason="No changed files matched this check",
            )

        safety_reason = _safety_reason(spec, policy)
        if safety_reason:
            callback(f"BLOCK {spec.check_id}: {safety_reason}")
            return CheckResult(
                check_id=spec.check_id,
                description=spec.description,
                status="blocked",
                blocking=False,
                command=list(spec.command),
                started_at=_now(),
                reason=safety_reason,
            )

        command, command_error = _resolved_command(spec, config.allowed_executables)
        if command is None:
            status = "failed" if spec.blocking else "skipped"
            callback(f"{status.upper()} {spec.check_id}: {command_error}")
            return CheckResult(
                check_id=spec.check_id,
                description=spec.description,
                status=status,
                blocking=spec.blocking,
                command=list(spec.command),
                started_at=_now(),
                reason=command_error,
            )

        if dry_run:
            callback(f"PLAN  {spec.check_id}: {' '.join(spec.command)}")
            return CheckResult(
                check_id=spec.check_id,
                description=spec.description,
                status="planned",
                blocking=spec.blocking,
                command=list(spec.command),
                started_at=_now(),
                reason=f"Resource class: {spec.resource}",
            )

        cache_key = cache.key(spec, workspace_key)
        cached = cache.get(cache_key) if spec.cache else None
        if cached:
            callback(f"CACHE {spec.check_id}")
            return CheckResult(
                check_id=spec.check_id,
                description=spec.description,
                status="passed",
                blocking=spec.blocking,
                command=list(spec.command),
                started_at=_now(),
                duration_seconds=float(cached.get("duration_seconds", 0.0)),
                exit_code=0,
                reason="Reused matching successful evidence",
                output_tail=str(cached.get("output_tail", "")),
                cached=True,
            )

        log_path = logs_dir / f"{spec.check_id}.log"
        callback(f"START {spec.check_id} [{spec.resource}]")
        async with semaphores[spec.resource]:
            started_at = _now()
            try:
                exit_code, duration, output_tail, reason = await _execute(
                    spec, command, root, log_path
                )
            except OSError as error:
                exit_code, duration, output_tail, reason = None, 0.0, "", str(error)

        if reason:
            status = "failed" if spec.blocking else "warning"
        elif exit_code == 0:
            status = "passed"
        else:
            status = "failed" if spec.blocking else "warning"
            reason = f"Exited with code {exit_code}"
        result = CheckResult(
            check_id=spec.check_id,
            description=spec.description,
            status=status,
            blocking=spec.blocking,
            command=list(spec.command),
            started_at=started_at,
            duration_seconds=round(duration, 3),
            exit_code=exit_code,
            reason=reason,
            log_path=str(log_path),
            output_tail=output_tail,
        )
        cache.put(cache_key, result)
        callback(f"DONE  {spec.check_id}: {status} ({duration:.1f}s)")
        return result

    for check_id, spec in selected.items():
        tasks[check_id] = asyncio.create_task(run_one(spec))
    if not tasks:
        return []
    results = await asyncio.gather(*tasks.values())
    return sorted(results, key=lambda result: result.check_id)
