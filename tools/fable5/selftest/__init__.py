from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from ..docs_check import check_docs
from ..models import CheckResult
from ..plan_review import review_plan


DETECTORS = frozenset(
    {"semgrep-cap-single-charge", "gitleaks", "validate-agents", "plan-review", "docs-check"}
)
_HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_SECRET_CANARY_MARKER = "{{FABLE5_SECRET_CANARY}}"


@dataclass(frozen=True)
class CanaryCase:
    name: str
    target_files: tuple[str, ...]
    patch: str
    expected_detector: str


def _string_list(item: dict[str, Any], key: str, name: str) -> tuple[str, ...]:
    value = item.get(key)
    if not isinstance(value, list) or not value or not all(
        isinstance(part, str) and part for part in value
    ):
        raise ValueError(f"Canary {name!r} must have a non-empty {key} string list")
    return tuple(value)


def _safe_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts or "\\" in value:
        raise ValueError(f"Canary target must be a safe repository-relative path: {value!r}")
    return Path(*pure.parts)


def load_cases(cases_dir: Path) -> tuple[CanaryCase, ...]:
    cases: list[CanaryCase] = []
    seen: set[str] = set()
    for path in sorted(cases_dir.glob("*.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid canary JSON in {path}: {error}") from error
        if not isinstance(item, dict):
            raise ValueError(f"Canary file must contain an object: {path}")
        name = str(item.get("name", "")).strip()
        if not name or name in seen:
            raise ValueError(f"Canary names must be non-empty and unique: {name!r}")
        seen.add(name)
        target_files = _string_list(item, "target_files", name)
        for target in target_files:
            _safe_relative(target)
        patch = item.get("patch")
        if not isinstance(patch, str) or not patch.startswith("--- a/"):
            raise ValueError(f"Canary {name!r} must have a unified diff patch")
        detector = str(item.get("expected_detector", "")).strip()
        if detector not in DETECTORS:
            raise ValueError(f"Canary {name!r} has unknown detector {detector!r}")
        cases.append(
            CanaryCase(
                name=name,
                target_files=target_files,
                patch=patch,
                expected_detector=detector,
            )
        )
    if not cases:
        raise ValueError(f"No canary cases found in {cases_dir}")
    return tuple(cases)


def _diff_path(header: str) -> str:
    value = header[4:].split("\t", 1)[0].strip()
    if not value.startswith(("a/", "b/")):
        raise ValueError(f"Canary patch path must start with a/ or b/: {value!r}")
    return value[2:]


def _apply_file_patch(
    target: Path, lines: list[str], start: int
) -> tuple[list[str], int, bool]:
    source_text = target.read_text(encoding="utf-8")
    source = source_text.splitlines()
    output: list[str] = []
    source_index = 0
    index = start
    saw_hunk = False
    while index < len(lines) and not lines[index].startswith("--- "):
        match = _HUNK_HEADER.match(lines[index])
        if match is None:
            raise ValueError(f"Expected unified diff hunk, got: {lines[index]!r}")
        saw_hunk = True
        old_start = int(match.group(1))
        old_expected = int(match.group(2) or "1")
        new_expected = int(match.group(4) or "1")
        hunk_start = old_start - 1
        if hunk_start < source_index or hunk_start > len(source):
            raise ValueError(f"Patch hunk starts outside {target}")
        output.extend(source[source_index:hunk_start])
        source_index = hunk_start
        old_seen = 0
        new_seen = 0
        index += 1
        while index < len(lines) and not lines[index].startswith(("@@ ", "--- ")):
            line = lines[index]
            if line == "\\ No newline at end of file":
                index += 1
                continue
            if not line or line[0] not in {" ", "+", "-"}:
                raise ValueError(f"Invalid unified diff line: {line!r}")
            marker, content = line[0], line[1:]
            if marker in {" ", "-"}:
                if source_index >= len(source) or source[source_index] != content:
                    raise ValueError(f"Patch context does not match {target}: {content!r}")
                source_index += 1
                old_seen += 1
            if marker in {" ", "+"}:
                output.append(content)
                new_seen += 1
            index += 1
        if old_seen != old_expected or new_seen != new_expected:
            raise ValueError(
                f"Patch hunk count mismatch for {target}: "
                f"old {old_seen}/{old_expected}, new {new_seen}/{new_expected}"
            )
    if not saw_hunk:
        raise ValueError(f"Canary patch has no hunks for {target}")
    output.extend(source[source_index:])
    return output, index, source_text.endswith(("\n", "\r"))


def apply_unified_patch(scratch: Path, patch: str, allowed_targets: set[str]) -> None:
    lines = patch.splitlines()
    index = 0
    patched: set[str] = set()
    while index < len(lines):
        if not lines[index].startswith("--- ") or index + 1 >= len(lines):
            raise ValueError("Canary patch must contain paired file headers")
        old_path = _diff_path(lines[index])
        if not lines[index + 1].startswith("+++ "):
            raise ValueError("Canary patch is missing a new-file header")
        new_path = _diff_path(lines[index + 1])
        if old_path != new_path or old_path not in allowed_targets:
            raise ValueError(f"Canary patch may modify only declared targets: {new_path!r}")
        target = scratch / _safe_relative(new_path)
        output, index, had_newline = _apply_file_patch(target, lines, index + 2)
        rendered = "\n".join(output)
        if had_newline and output:
            rendered += "\n"
        target.write_text(rendered, encoding="utf-8")
        patched.add(new_path)
    if patched != allowed_targets:
        missing = sorted(allowed_targets - patched)
        raise ValueError(f"Canary patch did not modify every declared target: {missing}")


def prepare_case(repo_root: Path, case: CanaryCase, scratch: Path) -> tuple[Path, ...]:
    copied: list[Path] = []
    for value in case.target_files:
        relative = _safe_relative(value)
        source = repo_root / relative
        if not source.is_file():
            raise FileNotFoundError(f"Canary target not found: {source}")
        destination = scratch / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied.append(destination)
    patch = case.patch
    if _SECRET_CANARY_MARKER in patch:
        if case.expected_detector != "gitleaks":
            raise ValueError("Secret canary marker is valid only for the gitleaks detector")
        seeded_secret = "".join(
            ("GITHUB", "_TOKEN=", "ghp_", "Q7wE2rT9yU4iO6pA1sD8", "fG3hJ5kL0zX2cV9b")
        )
        patch = patch.replace(_SECRET_CANARY_MARKER, seeded_secret)
    apply_unified_patch(scratch, patch, set(case.target_files))
    return tuple(copied)


def _run_command(
    command: list[str], *, cwd: Path, environment: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )


def _semgrep_detector(
    repo_root: Path, scratch: Path, targets: tuple[Path, ...]
) -> tuple[bool, list[str], str]:
    executable = shutil.which("semgrep") or "semgrep"
    command = [
        executable,
        "scan",
        "--disable-version-check",
        "--config",
        str(repo_root / "tools" / "fable5" / "semgrep.yml"),
        "--metrics=off",
        "--no-rewrite-rule-ids",
        "--exclude-rule",
        "fable5-no-dynamic-code-execution",
        "--exclude-rule",
        "fable5-review-child-process-exec",
        "--no-git-ignore",
        "--json",
        *(str(target) for target in targets),
    ]
    environment = os.environ.copy()
    environment["SEMGREP_LOG_FILE"] = str(scratch / ".semgrep.log")
    environment["SEMGREP_SETTINGS_FILE"] = str(scratch / ".semgrep-settings.yml")
    environment["SEMGREP_VERSION_CACHE_PATH"] = str(scratch / ".semgrep-version")
    completed = _run_command(command, cwd=scratch, environment=environment)
    if completed.returncode != 0:
        return False, command, f"semgrep failed with code {completed.returncode}: {completed.stderr}"
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return False, command, "semgrep returned invalid JSON"
    found = any(
        str(item.get("check_id", "")).endswith("fable5-cap-single-charge")
        for item in payload.get("results", [])
        if isinstance(item, dict)
    )
    return found, command, "cap single-charge rule result"


def _gitleaks_detector(scratch: Path, targets: tuple[Path, ...]) -> tuple[bool, list[str], str]:
    executable = shutil.which("gitleaks") or "gitleaks"
    displayed_command = [executable, "dir", "<target files>"]
    for target in targets:
        command = [
            executable,
            "dir",
            "--no-banner",
            "--no-color",
            "--redact",
            "--exit-code",
            "1",
            str(target),
        ]
        completed = _run_command(command, cwd=scratch)
        if completed.returncode == 1:
            return True, command, "gitleaks reported a seeded secret"
        if completed.returncode != 0:
            detail = completed.stderr or completed.stdout
            return False, command, f"gitleaks failed with code {completed.returncode}: {detail}"
    return False, displayed_command, "gitleaks reported no secrets"


def _validate_agents_detector(
    repo_root: Path, scratch: Path, targets: tuple[Path, ...]
) -> tuple[bool, list[str], str]:
    executable = shutil.which("node") or "node"
    validator_uri = (repo_root / "scripts" / "validate-agents.mjs").as_uri()
    script = (
        "import fs from 'node:fs';"
        f"import {{ validateAgentFile }} from {json.dumps(validator_uri)};"
        "const result = validateAgentFile(fs.readFileSync(process.argv[1], 'utf8'));"
        "console.log(JSON.stringify(result));"
        "process.exit(result.ok ? 0 : 1);"
    )
    command = [executable, "--input-type=module", "-e", script, str(targets[0])]
    completed = _run_command(command, cwd=scratch)
    if completed.returncode not in {0, 1}:
        return False, command, f"validate-agents failed with code {completed.returncode}"
    return completed.returncode == 1, command, completed.stdout.strip()


def _run_detector(
    repo_root: Path,
    scratch: Path,
    case: CanaryCase,
    targets: tuple[Path, ...],
) -> tuple[bool, list[str], str]:
    if case.expected_detector == "semgrep-cap-single-charge":
        return _semgrep_detector(repo_root, scratch, targets)
    if case.expected_detector == "gitleaks":
        return _gitleaks_detector(scratch, targets)
    if case.expected_detector == "validate-agents":
        return _validate_agents_detector(repo_root, scratch, targets)
    relative_targets = [target.relative_to(scratch).as_posix() for target in targets]
    if case.expected_detector == "plan-review":
        review = review_plan(targets[0], scratch)
        found = any(
            finding.code in {"criterion-without-proof", "missing-proof"}
            for finding in review.findings
        )
        return found, ["plan-review", relative_targets[0]], review.verdict
    results = check_docs(scratch, relative_targets, set())
    found = any(result.status == "warning" for result in results)
    detail = "; ".join(result.reason for result in results if result.reason)
    return found, ["docs-check", *relative_targets], detail


def run_case(repo_root: Path, case: CanaryCase) -> CheckResult:
    started_at = datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix="fable5-selftest-") as temporary:
        scratch = Path(temporary)
        targets = prepare_case(repo_root, case, scratch)
        try:
            detected, command, detail = _run_detector(repo_root, scratch, case, targets)
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            detected, command, detail = False, [case.expected_detector], str(error)
    status = "passed" if detected else "failed"
    reason = (
        f"Expected detector {case.expected_detector} found the seeded defect"
        if detected
        else f"Expected detector {case.expected_detector} did not detect the seeded defect: {detail}"
    )
    return CheckResult(
        check_id=f"selftest:{case.name}",
        description=f"Canary {case.name}",
        status=status,
        blocking=True,
        command=command,
        started_at=started_at,
        reason=reason,
        output_tail=detail,
    )


def run_selftest(repo_root: Path, cases_dir: Path | None = None) -> list[CheckResult]:
    directory = cases_dir or Path(__file__).with_name("cases")
    return [run_case(repo_root, case) for case in load_cases(directory)]
