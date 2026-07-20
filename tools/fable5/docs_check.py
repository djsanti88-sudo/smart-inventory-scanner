from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from .models import CheckResult


_BACKTICK_SPAN = re.compile(r"`([^`\n]+)`")
_NPM_RUN = re.compile(r"npm run ([A-Za-z0-9_:.\-]+)")
_MARKDOWN_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")

_DEFAULT_PROGRESS_NOTE = "PROGRESS.md lags the newest plan (allowed by doctrine)"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _looks_like_path_span(span: str) -> bool:
    if not span or span.startswith("-"):
        return False
    if "*" in span or "?" in span:
        return False
    if "<" in span or ">" in span:
        return False
    if "://" in span:
        return False
    if "/" in span:
        return True
    return bool(re.search(r"\.(md|ts|tsx|mjs|py|json|yml|yaml|toml|js|jsx|css)$", span))


def _dead_path_spans(text: str, root: Path) -> list[str]:
    dead: list[str] = []
    for match in _BACKTICK_SPAN.finditer(text):
        span = match.group(1).strip()
        if not _looks_like_path_span(span):
            continue
        if not (root / span).exists():
            dead.append(span)
    return dead


def _dead_npm_scripts(text: str, package_scripts: set[str]) -> list[str]:
    dead: list[str] = []
    for match in _NPM_RUN.finditer(text):
        script = match.group(1)
        if script not in package_scripts:
            dead.append(f"npm run {script}")
    return dead


def _broken_relative_links(text: str, doc_dir: Path) -> list[str]:
    broken: list[str] = []
    for match in _MARKDOWN_LINK.finditer(text):
        target = match.group(1).strip()
        if not target or target.startswith(("http://", "https://", "mailto:")):
            continue
        target = target.split("#", 1)[0].strip()
        if not target:
            continue
        if not (doc_dir / target).exists():
            broken.append(target)
    return broken


def _newest_plan_mtime(root: Path) -> float | None:
    plans_dir = root / "docs" / "superpowers" / "plans"
    if not plans_dir.is_dir():
        return None
    mtimes = [path.stat().st_mtime for path in plans_dir.glob("*.md") if path.is_file()]
    return max(mtimes) if mtimes else None


def check_docs(root: Path, files: list[str], package_scripts: set[str]) -> list[CheckResult]:
    results: list[CheckResult] = []
    for filename in files:
        started_at = _now()
        check_id = f"docs-staleness:{filename}"
        doc_path = root / filename
        if not doc_path.is_file():
            results.append(
                CheckResult(
                    check_id=check_id,
                    description=f"Check {filename} for dead references",
                    status="warning",
                    blocking=False,
                    command=[],
                    started_at=started_at,
                    reason="file not found",
                )
            )
            continue

        text = doc_path.read_text(encoding="utf-8", errors="replace")
        dead_paths = _dead_path_spans(text, root)
        dead_scripts = _dead_npm_scripts(text, package_scripts)
        broken_links = _broken_relative_links(text, doc_path.parent)

        issues: list[str] = []
        issues.extend(f"dead path `{span}`" for span in dead_paths)
        issues.extend(f"dead script `{script}`" for script in dead_scripts)
        issues.extend(f"broken link `{target}`" for target in broken_links)

        progress_note = ""
        if filename == "PROGRESS.md":
            newest_plan_mtime = _newest_plan_mtime(root)
            if newest_plan_mtime is not None and doc_path.stat().st_mtime < newest_plan_mtime:
                progress_note = f"INFO: {_DEFAULT_PROGRESS_NOTE}"

        if issues:
            reason_parts = list(issues)
            if progress_note:
                reason_parts.append(progress_note)
            results.append(
                CheckResult(
                    check_id=check_id,
                    description=f"Check {filename} for dead references",
                    status="warning",
                    blocking=False,
                    command=[],
                    started_at=started_at,
                    reason="; ".join(reason_parts),
                )
            )
        else:
            reason = progress_note if progress_note else ""
            results.append(
                CheckResult(
                    check_id=check_id,
                    description=f"Check {filename} for dead references",
                    status="passed",
                    blocking=False,
                    command=[],
                    started_at=started_at,
                    reason=reason,
                )
            )
    return results
