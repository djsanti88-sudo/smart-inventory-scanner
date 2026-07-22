from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .models import CheckResult


MAX_MUTANTS = 10
MUTANT_TIMEOUT_SECONDS = 120
MUTATION_RUNNER_ENV = "FABLE5_MUTATION_RUNNER"
_DATABASE_DEPENDENCY = re.compile(r"better-sqlite3|@?libsql", re.IGNORECASE)
_OPERATORS: tuple[tuple[str, str, str], ...] = (
    ("===", "!==", "strict equality to inequality"),
    ("!==", "===", "strict inequality to equality"),
    (">=", "<", "greater or equal boundary"),
    ("<=", ">", "less or equal boundary"),
    ("&&", "||", "logical and to or"),
    ("||", "&&", "logical or to and"),
    (">", "<=", "greater than boundary"),
    ("<", ">=", "less than boundary"),
    ("true", "false", "true to false"),
    ("false", "true", "false to true"),
)
_OPERATOR_PATTERN = re.compile(
    r"===|!==|>=|<=|&&|\|\||>|<|\btrue\b|\bfalse\b"
)
_REPLACEMENTS = {operator: (replacement, label) for operator, replacement, label in _OPERATORS}


@dataclass(frozen=True)
class Mutant:
    start: int
    end: int
    original: str
    replacement: str
    label: str
    line: int

    def apply(self, source: str) -> str:
        return source[: self.start] + self.replacement + source[self.end :]


@dataclass(frozen=True)
class _Candidate:
    source_path: str
    test_path: str
    source: str
    mutants: tuple[Mutant, ...]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def contains_database_dependency(test_source: str) -> bool:
    """Match the forbidden database strings exactly as the pre-probe grep requires."""
    return _DATABASE_DEPENDENCY.search(test_source) is not None


def _code_mask(source: str) -> str:
    """Blank comments and string bodies while preserving offsets and line breaks."""
    output = list(source)
    state = "code"
    quote = ""
    index = 0
    while index < len(source):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if state == "code":
            if char == "/" and following == "/":
                output[index] = output[index + 1] = " "
                state = "line-comment"
                index += 2
                continue
            if char == "/" and following == "*":
                output[index] = output[index + 1] = " "
                state = "block-comment"
                index += 2
                continue
            if char in {"'", '"', "`"}:
                output[index] = " "
                quote = char
                state = "string"
            index += 1
            continue
        if state == "line-comment":
            if char == "\n":
                state = "code"
            else:
                output[index] = " "
            index += 1
            continue
        if state == "block-comment":
            if char == "*" and following == "/":
                output[index] = output[index + 1] = " "
                state = "code"
                index += 2
                continue
            if char != "\n":
                output[index] = " "
            index += 1
            continue
        output[index] = "\n" if char == "\n" else " "
        if char == "\\" and index + 1 < len(source):
            index += 1
            if source[index] != "\n":
                output[index] = " "
        elif char == quote:
            state = "code"
        index += 1
    return "".join(output)


def generate_mutants(source: str, limit: int = MAX_MUTANTS) -> list[Mutant]:
    """Generate a small deterministic set of expression mutants for TypeScript source."""
    mutants: list[Mutant] = []
    for match in _OPERATOR_PATTERN.finditer(_code_mask(source)):
        original = match.group(0)
        replacement, label = _REPLACEMENTS[original]
        mutants.append(
            Mutant(
                start=match.start(),
                end=match.end(),
                original=original,
                replacement=replacement,
                label=label,
                line=source.count("\n", 0, match.start()) + 1,
            )
        )
        if len(mutants) >= max(0, limit):
            break
    return mutants


def _is_source_module(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return normalized.endswith(".ts") and not normalized.endswith(
        (".test.ts", ".spec.ts", ".d.ts")
    )


def _sibling_test(path: Path) -> Path:
    return path.with_name(f"{path.stem}.test.ts")


def _safe_environment() -> dict[str, str]:
    blocked = ("TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE_KEY")
    environment = {
        key: value
        for key, value in os.environ.items()
        if not any(fragment in key.upper() for fragment in blocked)
    }
    environment["CI"] = "1"
    environment["NO_COLOR"] = "1"
    return environment


def _runner_command(worktree: Path, source_path: str, test_path: str) -> list[str]:
    configured = os.environ.get(MUTATION_RUNNER_ENV)
    if configured:
        try:
            raw = json.loads(configured)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"{MUTATION_RUNNER_ENV} must be a JSON command array") from error
        if not isinstance(raw, list) or not raw or not all(isinstance(item, str) for item in raw):
            raise RuntimeError(f"{MUTATION_RUNNER_ENV} must be a non-empty JSON string array")
        replacements = {
            "{source}": str(worktree / Path(source_path)),
            "{test}": str(worktree / Path(test_path)),
        }
        return [replacements.get(item, item) for item in raw]

    executable = worktree / "node_modules" / ".bin" / (
        "vitest.cmd" if os.name == "nt" else "vitest"
    )
    if not executable.is_file():
        raise RuntimeError(f"Vitest executable missing from shared node_modules: {executable}")
    return [str(executable), "run", Path(test_path).as_posix()]


def _run_test_command(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    timeout_seconds: int = MUTANT_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )


def _add_worktree(root: Path, worktree: Path) -> None:
    completed = subprocess.run(
        ["git", "worktree", "add", "--detach", "--quiet", str(worktree), "HEAD"],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Could not create mutation worktree: {completed.stdout.strip()}")


def _create_node_modules_junction(root: Path, worktree: Path) -> Path:
    source = root / "node_modules"
    target = worktree / "node_modules"
    if not source.is_dir():
        raise RuntimeError("Main repository node_modules is missing; mutation probes will not install it")
    if os.name == "nt":
        completed = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(target), str(source)],
            cwd=worktree,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=30,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"Could not create node_modules directory junction: {completed.stdout.strip()}"
            )
    else:
        target.symlink_to(source, target_is_directory=True)
    return target


def _remove_node_modules_link(target: Path) -> None:
    if not target.exists() and not target.is_symlink():
        return
    if os.name == "nt":
        target.rmdir()
    else:
        target.unlink()


def _remove_worktree(root: Path, worktree: Path) -> None:
    subprocess.run(
        ["git", "worktree", "remove", "--force", str(worktree)],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
        check=False,
    )
    subprocess.run(
        ["git", "worktree", "prune"],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
        check=False,
    )


@contextmanager
def _temporary_worktree(root: Path) -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="fable5-mutation-") as temporary:
        worktree = Path(temporary) / "worktree"
        added = False
        junction: Path | None = None
        try:
            _add_worktree(root, worktree)
            added = True
            junction = _create_node_modules_junction(root, worktree)
            yield worktree
        finally:
            if junction is not None:
                _remove_node_modules_link(junction)
            if added:
                _remove_worktree(root, worktree)


def _copy_into_worktree(root: Path, worktree: Path, relative_path: str) -> None:
    source = root / Path(relative_path)
    destination = worktree / Path(relative_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def _collect_candidates(root: Path, changed_files: list[str]) -> tuple[list[_Candidate], list[str]]:
    candidates: list[_Candidate] = []
    skipped: list[str] = []
    remaining = MAX_MUTANTS
    seen: set[str] = set()
    for relative_path in changed_files:
        normalized = Path(relative_path).as_posix()
        if normalized in seen or not _is_source_module(normalized):
            continue
        seen.add(normalized)
        source_path = root / Path(normalized)
        if not source_path.is_file():
            skipped.append(f"{normalized}: source file missing")
            continue
        test_path = _sibling_test(source_path)
        try:
            test_relative = test_path.relative_to(root).as_posix()
        except ValueError:
            skipped.append(f"{normalized}: sibling test escapes repository")
            continue
        if not test_path.is_file():
            skipped.append(f"{normalized}: no sibling .test.ts")
            continue
        test_source = test_path.read_text(encoding="utf-8")
        if contains_database_dependency(test_source):
            skipped.append(f"{normalized}: database dependency in sibling test")
            continue
        source = source_path.read_text(encoding="utf-8")
        mutants = generate_mutants(source, limit=remaining)
        if not mutants:
            skipped.append(f"{normalized}: no supported mutation points")
            continue
        candidates.append(
            _Candidate(
                source_path=normalized,
                test_path=test_relative,
                source=source,
                mutants=tuple(mutants),
            )
        )
        remaining -= len(mutants)
        if remaining == 0:
            break
    return candidates, skipped


def _write_log(log_path: Path, lines: list[str]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_mutation_probes(
    *,
    root: Path,
    changed_files: list[str],
    report_dir: Path,
    dry_run: bool = False,
) -> CheckResult:
    """Probe changed TypeScript modules in one isolated worktree and report weak tests."""
    started_at = _now()
    started_timer = time.perf_counter()
    candidates, skipped = _collect_candidates(root, changed_files)
    command = ["vitest", "run", "<sibling *.test.ts>"]
    log_path = report_dir / "logs" / "mutation.log"

    if not candidates:
        reason = "; ".join(skipped) if skipped else "No changed TypeScript modules were eligible"
        return CheckResult(
            check_id="mutation-probes",
            description="Changed-file mutation probes",
            status="skipped",
            blocking=False,
            command=command,
            started_at=started_at,
            reason=reason,
        )

    mutant_count = sum(len(candidate.mutants) for candidate in candidates)
    if dry_run:
        return CheckResult(
            check_id="mutation-probes",
            description="Changed-file mutation probes",
            status="planned",
            blocking=False,
            command=command,
            started_at=started_at,
            reason=f"Would probe {mutant_count} mutants in one temporary worktree",
        )

    lines = [
        "Mutation probe session",
        "Worktrees created: 1",
        f"Mutant cap: {MAX_MUTANTS}",
        f"Per-mutant timeout seconds: {MUTANT_TIMEOUT_SECONDS}",
    ]
    lines.extend(f"SKIP {reason}" for reason in skipped)
    killed = 0
    survived = 0
    timed_out = 0
    baseline_failures = 0
    errors: list[str] = []

    try:
        with _temporary_worktree(root) as worktree:
            environment = _safe_environment()
            for candidate in candidates:
                _copy_into_worktree(root, worktree, candidate.source_path)
                _copy_into_worktree(root, worktree, candidate.test_path)
                source_path = worktree / Path(candidate.source_path)
                test_command = _runner_command(
                    worktree, candidate.source_path, candidate.test_path
                )
                try:
                    baseline = _run_test_command(
                        test_command,
                        cwd=worktree,
                        environment=environment,
                        timeout_seconds=MUTANT_TIMEOUT_SECONDS,
                    )
                except subprocess.TimeoutExpired:
                    timed_out += 1
                    lines.append(f"SKIP {candidate.source_path}: baseline test timed out")
                    continue
                except OSError as error:
                    errors.append(f"{candidate.source_path}: baseline runner error: {error}")
                    continue
                if baseline.returncode != 0:
                    baseline_failures += 1
                    lines.append(
                        f"SKIP {candidate.source_path}: baseline sibling test exited "
                        f"{baseline.returncode}"
                    )
                    continue

                for mutant in candidate.mutants:
                    source_path.write_text(mutant.apply(candidate.source), encoding="utf-8")
                    try:
                        completed = _run_test_command(
                            test_command,
                            cwd=worktree,
                            environment=environment,
                            timeout_seconds=MUTANT_TIMEOUT_SECONDS,
                        )
                    except subprocess.TimeoutExpired:
                        timed_out += 1
                        lines.append(
                            f"TIMEOUT {candidate.source_path}:{mutant.line} {mutant.label}"
                        )
                    except OSError as error:
                        errors.append(
                            f"{candidate.source_path}:{mutant.line} runner error: {error}"
                        )
                    else:
                        if completed.returncode == 0:
                            survived += 1
                            lines.append(
                                f"SURVIVED {candidate.source_path}:{mutant.line} "
                                f"{mutant.original} -> {mutant.replacement} "
                                f"test={candidate.test_path}"
                            )
                        else:
                            killed += 1
                            lines.append(
                                f"KILLED {candidate.source_path}:{mutant.line} "
                                f"{mutant.original} -> {mutant.replacement} "
                                f"test={candidate.test_path}"
                            )
                    finally:
                        source_path.write_text(candidate.source, encoding="utf-8")
    except (OSError, RuntimeError) as error:
        errors.append(str(error))

    _write_log(log_path, lines + [f"ERROR {error}" for error in errors])
    reason_parts: list[str] = []
    if killed:
        reason_parts.append(f"{killed} killed")
    if survived:
        reason_parts.append(f"{survived} survived")
    if timed_out:
        reason_parts.append(f"{timed_out} timed out")
    if baseline_failures:
        reason_parts.append(f"{baseline_failures} baseline failed")
    if errors:
        reason_parts.append(f"{len(errors)} errors")
    status = "warning" if survived or timed_out or baseline_failures or errors else "passed"
    return CheckResult(
        check_id="mutation-probes",
        description="Changed-file mutation probes",
        status=status,
        blocking=False,
        command=command,
        started_at=started_at,
        duration_seconds=round(time.perf_counter() - started_timer, 3),
        exit_code=0 if not errors else None,
        reason=", ".join(reason_parts) or "No mutants completed",
        log_path=str(log_path),
        output_tail="\n".join(lines[-40:]),
    )
