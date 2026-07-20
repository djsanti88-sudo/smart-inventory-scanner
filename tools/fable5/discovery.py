from __future__ import annotations

import fnmatch
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

from .config import FableConfig
from .models import CapabilityInventory


TOOL_NAMES = (
    "git",
    "node",
    "npm",
    "npx",
    "python",
    "semgrep",
    "gitleaks",
    "osv-scanner",
    "ruff",
    "pip-audit",
    "docker",
    "ollama",
    "claude",
    "codex",
)


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout.strip() if completed.returncode == 0 else ""


def find_repo_root(start: Path) -> Path:
    candidate = start.resolve()
    output = _git(candidate, "rev-parse", "--show-toplevel")
    if output:
        return Path(output).resolve()
    for parent in (candidate, *candidate.parents):
        if (parent / "package.json").is_file() or (parent / ".git").exists():
            return parent
    raise RuntimeError(f"Could not locate a repository from {start}")


def git_head(root: Path) -> str:
    return _git(root, "rev-parse", "HEAD") or "unavailable"


def changed_files(root: Path) -> list[str]:
    names: set[str] = set()
    commands = (
        ("diff", "--name-only", "--relative", "HEAD"),
        ("ls-files", "--others", "--exclude-standard"),
        ("diff", "--name-only", "--relative", "@{upstream}...HEAD"),
    )
    for command in commands:
        output = _git(root, *command)
        names.update(line.strip().replace("\\", "/") for line in output.splitlines() if line.strip())
    return sorted(names)


def workspace_fingerprint(root: Path, files: list[str], config_path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(git_head(root).encode())
    config_relative = config_path.relative_to(root).as_posix()
    for relative in sorted(set(files) | {config_relative}):
        digest.update(relative.encode())
        path = root / relative
        if not path.is_file():
            digest.update(b"<missing>")
            continue
        stat = path.stat()
        digest.update(str(stat.st_size).encode())
        if stat.st_size <= 20 * 1024 * 1024:
            digest.update(path.read_bytes())
        else:
            digest.update(str(stat.st_mtime_ns).encode())
    return digest.hexdigest()


def _load_package_scripts(root: Path) -> tuple[str, ...]:
    package = root / "package.json"
    if not package.is_file():
        return ()
    try:
        data = json.loads(package.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ()
    return tuple(sorted(str(name) for name in data.get("scripts", {})))


def _discover_skills(home: Path) -> tuple[str, ...]:
    roots = (home / ".codex" / "skills", home / ".codex" / "plugins" / "cache")
    found: set[str] = set()
    for base in roots:
        if not base.is_dir():
            continue
        for path in base.glob("**/SKILL.md"):
            found.add(path.parent.name)
    return tuple(sorted(found))


def _discover_plugins(home: Path) -> tuple[str, ...]:
    base = home / ".codex" / "plugins" / "cache"
    found: set[str] = set()
    if not base.is_dir():
        return ()
    for manifest in base.glob("**/.codex-plugin/plugin.json"):
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            found.add(str(data.get("name") or manifest.parents[1].name))
        except (OSError, json.JSONDecodeError):
            found.add(manifest.parents[1].name)
    if not found:
        for category in base.iterdir():
            if category.is_dir():
                found.update(path.name for path in category.iterdir() if path.is_dir())
    return tuple(sorted(found))


def discover_capabilities(root: Path, config: FableConfig) -> CapabilityInventory:
    tools = {name: shutil.which(name) for name in TOOL_NAMES}
    agents_dir = root / config.agents_dir
    agents = tuple(sorted(path.stem for path in agents_dir.glob("*.md"))) if agents_dir.is_dir() else ()
    home = Path.home()
    return CapabilityInventory(
        tools=tools,
        agents=agents,
        skills=_discover_skills(home),
        plugins=_discover_plugins(home),
        package_scripts=_load_package_scripts(root),
    )


def select_agents(
    config: FableConfig,
    files: list[str],
    available_agents: tuple[str, ...],
    *,
    all_agents: bool = False,
) -> list[str]:
    if all_agents:
        return list(available_agents)
    selected: set[str] = {"code-review"}
    for route in config.routes:
        if any(
            fnmatch.fnmatch(path, pattern)
            for path in files
            for pattern in route.patterns
        ):
            selected.update(route.agents)
    return sorted(selected.intersection(available_agents))


def matches_changed_paths(patterns: tuple[str, ...], files: list[str]) -> bool:
    if not patterns:
        return True
    return any(fnmatch.fnmatch(path, pattern) for path in files for pattern in patterns)

