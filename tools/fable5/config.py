from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .models import CheckSpec


@dataclass(frozen=True)
class Route:
    patterns: tuple[str, ...]
    agents: tuple[str, ...]


@dataclass(frozen=True)
class FableConfig:
    project_name: str
    reports_dir: str
    cache_db: str
    agents_dir: str
    light_workers: int
    heavy_workers: int
    browser_workers: int
    allowed_executables: frozenset[str]
    checks: tuple[CheckSpec, ...]
    routes: tuple[Route, ...]
    expert_workers: int = 3
    docs_files: list[str] = field(default_factory=lambda: ["CLAUDE.md", "docs/ARCHITECTURE.md", "docs/COMMANDS.md"])


def _tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("Expected a TOML array of strings")
    return tuple(value)


def load_config(root: Path, config_path: Path | None = None) -> FableConfig:
    path = config_path or root / "fable5.toml"
    if not path.is_file():
        raise FileNotFoundError(f"Fable 5 configuration not found: {path}")
    with path.open("rb") as handle:
        raw = tomllib.load(handle)

    project = raw.get("project", {})
    scheduler = raw.get("scheduler", {})
    safety = raw.get("safety", {})
    docs = raw.get("docs", {})
    allowed = frozenset(str(item).lower() for item in safety.get("allowed_executables", []))
    if not allowed:
        raise ValueError("safety.allowed_executables must not be empty")

    checks: list[CheckSpec] = []
    seen: set[str] = set()
    for item in raw.get("checks", []):
        check_id = str(item.get("id", "")).strip()
        if not check_id or check_id in seen:
            raise ValueError(f"Check IDs must be non-empty and unique: {check_id!r}")
        seen.add(check_id)
        command = _tuple(item.get("command"))
        if not command:
            raise ValueError(f"Check {check_id!r} has no command")
        resource = str(item.get("resource", "light"))
        if resource not in {"light", "heavy", "browser"}:
            raise ValueError(f"Check {check_id!r} has invalid resource class {resource!r}")
        checks.append(
            CheckSpec(
                check_id=check_id,
                description=str(item.get("description", check_id)),
                command=command,
                gates=frozenset(_tuple(item.get("gates"))),
                resource=resource,
                timeout_seconds=max(1, int(item.get("timeout_seconds", 300))),
                blocking=bool(item.get("blocking", True)),
                cache=bool(item.get("cache", True)),
                always_run=bool(item.get("always_run", False)),
                depends_on=_tuple(item.get("depends_on")),
                paths=_tuple(item.get("paths")),
                network=bool(item.get("network", False)),
                live=bool(item.get("live", False)),
                paid=bool(item.get("paid", False)),
                mutating=bool(item.get("mutating", False)),
            )
        )

    unknown_dependencies = {
        dependency
        for check in checks
        for dependency in check.depends_on
        if dependency not in seen
    }
    if unknown_dependencies:
        raise ValueError(f"Unknown check dependencies: {sorted(unknown_dependencies)}")

    routes = tuple(
        Route(patterns=_tuple(item.get("patterns")), agents=_tuple(item.get("agents")))
        for item in raw.get("routes", [])
    )
    return FableConfig(
        project_name=str(project.get("name", root.name)),
        reports_dir=str(project.get("reports_dir", "reports/fable5")),
        cache_db=str(project.get("cache_db", ".fable5/cache.sqlite3")),
        agents_dir=str(project.get("agents_dir", ".claude/agents")),
        light_workers=max(1, int(scheduler.get("light_workers", 6))),
        heavy_workers=max(1, int(scheduler.get("heavy_workers", 1))),
        browser_workers=max(1, int(scheduler.get("browser_workers", 1))),
        allowed_executables=allowed,
        checks=tuple(checks),
        routes=routes,
        expert_workers=max(1, int(scheduler.get("expert_workers", 3))),
        docs_files=list(_tuple(docs.get("files")))
        if "files" in docs
        else ["CLAUDE.md", "docs/ARCHITECTURE.md", "docs/COMMANDS.md"],
    )
